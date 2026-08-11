#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$')]
    [string]$ProjectName,

    [Parameter(Mandatory = $true)]
    [string]$UpstreamOrigin
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$CloudflareDirectory = Join-Path $Root 'cloudflare'
$Wrangler = Join-Path $CloudflareDirectory 'node_modules\.bin\wrangler.cmd'

$parsedOrigin = $null
try { $parsedOrigin = [Uri]$UpstreamOrigin } catch { throw 'UpstreamOrigin must be a valid HTTPS origin.' }
if ($parsedOrigin.Scheme -ne 'https' -or $parsedOrigin.AbsolutePath -ne '/' -or $parsedOrigin.Query -or $parsedOrigin.Fragment -or $parsedOrigin.UserInfo) {
    throw 'UpstreamOrigin must be a credential-free HTTPS origin with no path, query or fragment.'
}

if (-not (Test-Path -LiteralPath $Wrangler -PathType Leaf)) {
    & npm ci --prefix $CloudflareDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Installing Wrangler failed.' }
}

$projectsJson = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $projectsJson = & $Wrangler pages project list --json 2>&1
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
}
if ($LASTEXITCODE -ne 0) { throw 'Reading Cloudflare Pages projects failed after three attempts.' }
$projects = @($projectsJson | ConvertFrom-Json)
$exists = @($projects | Where-Object {
    $_.name -eq $ProjectName -or
    $_.project_name -eq $ProjectName -or
    $_.'Project Name' -eq $ProjectName
}).Count -gt 0
if (-not $exists) {
    & $Wrangler pages project create $ProjectName --production-branch main
    if ($LASTEXITCODE -ne 0) { throw 'Creating the Cloudflare Pages relay project failed.' }
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$deployDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot ("xbloom-pages-relay-deploy-" + [Guid]::NewGuid().ToString('N'))))
if (-not $deployDirectory.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary relay deployment directory escaped the system temp root.'
}

New-Item -ItemType Directory -Path $deployDirectory | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'index.html') -Destination $deployDirectory
    $worker = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '_worker.js'))
    $encodedOrigin = ConvertTo-Json $UpstreamOrigin -Compress
    $worker = $worker.Replace('"__XBLOOM_UPSTREAM_ORIGIN__"', $encodedOrigin)
    if ($worker.Contains('__XBLOOM_UPSTREAM_ORIGIN__')) {
        throw 'Relay upstream marker replacement failed.'
    }
    [IO.File]::WriteAllText(
        (Join-Path $deployDirectory '_worker.js'),
        $worker,
        (New-Object Text.UTF8Encoding($false))
    )

    # Pages treats a Wrangler configuration as the source of truth for
    # production bindings. Generate it only inside the disposable upload
    # directory so a fork never inherits the maintainer's public Worker URL.
    $wranglerConfig = [ordered]@{
        name = $ProjectName
        pages_build_output_dir = '.'
        compatibility_date = '2026-08-11'
        # Use a relay-specific binding name so upgrades also work for Pages
        # projects that previously stored UPSTREAM_ORIGIN as a secret.
        vars = [ordered]@{ RELAY_UPSTREAM_ORIGIN = $UpstreamOrigin }
    } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText(
        (Join-Path $deployDirectory 'wrangler.jsonc'),
        $wranglerConfig,
        (New-Object Text.UTF8Encoding($false))
    )

    $generatedWorker = [IO.File]::ReadAllText((Join-Path $deployDirectory '_worker.js'))
    if ($generatedWorker.Contains('__XBLOOM_UPSTREAM_ORIGIN__') -or -not $generatedWorker.Contains($UpstreamOrigin)) {
        throw 'Generated relay worker did not contain the configured upstream origin.'
    }

    # Pages resolves advanced-mode _worker.js from the process working
    # directory. Execute Wrangler inside the generated bundle so it cannot
    # reuse a source file from the caller's checkout.
    Push-Location $deployDirectory
    try {
        & $Wrangler pages deploy . --project-name $ProjectName --branch main --commit-dirty=true
        if ($LASTEXITCODE -ne 0) { throw 'Deploying the Cloudflare Pages relay failed.' }
    } finally {
        Pop-Location
    }
} finally {
    if (Test-Path -LiteralPath $deployDirectory) {
        Remove-Item -LiteralPath $deployDirectory -Recurse -Force
    }
}
