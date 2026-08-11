#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^https://')][string]$LlmBaseUrl,
    [Parameter(Mandatory=$true)][ValidateLength(1,200)][string]$LlmModel,
    [string]$WorkerName = 'xbloom-ai-brew-studio',
    [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Config = Join-Path $PSScriptRoot 'wrangler.generated.jsonc'
$Template = Join-Path $PSScriptRoot 'wrangler.template.jsonc'
$DatabaseName = ($WorkerName + '-db')

function Invoke-Npx([string[]]$Arguments) {
    & npx @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npx $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

Push-Location $Root
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
} finally { Pop-Location }

Push-Location $PSScriptRoot
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Cloudflare npm ci failed' }

    # Preflight only: compile without creating remote resources or secrets.
    if ($SkipDeploy) {
        $configText = (Get-Content -Raw -LiteralPath $Template -Encoding utf8)
        $configText = $configText.Replace('xbloom-ai-brew-studio', $WorkerName).Replace('https://YOUR_OPENAI_COMPATIBLE_HOST/v1', $LlmBaseUrl.TrimEnd('/')).Replace('YOUR_MODEL_ID', $LlmModel)
        [IO.File]::WriteAllText($Config, $configText, [Text.UTF8Encoding]::new($false))
        Invoke-Npx @('wrangler','deploy','--dry-run','--config',$Config)
        Write-Host 'Cloudflare preflight passed; no remote resources were changed.' -ForegroundColor Green
        return
    }

    $createOutput = (& npx wrangler d1 create $DatabaseName 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -and $createOutput -notmatch 'already exists') { throw $createOutput }
    $databaseId = [regex]::Match($createOutput, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'IgnoreCase').Value
    if (-not $databaseId) {
        $listOutput = (& npx wrangler d1 list --json 2>&1 | Out-String)
        $dbs = $listOutput | ConvertFrom-Json
        $databaseId = ($dbs | Where-Object { $_.name -eq $DatabaseName } | Select-Object -First 1).uuid
    }
    if (-not $databaseId) { throw "D1 database id was not found for $DatabaseName" }

    $configText = (Get-Content -Raw -LiteralPath $Template -Encoding utf8)
    $configText = $configText.Replace('xbloom-ai-brew-studio', $WorkerName).Replace('00000000-0000-0000-0000-000000000000', $databaseId).Replace('https://YOUR_OPENAI_COMPATIBLE_HOST/v1', $LlmBaseUrl.TrimEnd('/')).Replace('YOUR_MODEL_ID', $LlmModel)
    [IO.File]::WriteAllText($Config, $configText, [Text.UTF8Encoding]::new($false))

    Invoke-Npx @('wrangler','d1','migrations','apply',$DatabaseName,'--remote','--config',$Config)
    $secureKey = Read-Host 'LLM API Key (stored as Cloudflare Worker Secret)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        $plainKey | npx wrangler secret put LLM_API_KEY --config $Config
        if ($LASTEXITCODE -ne 0) { throw 'Saving LLM_API_KEY failed' }
    } finally {
        $plainKey = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $secretListOutput = (& npx wrangler secret list --config $Config --format json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw $secretListOutput }
    $secretList = @($secretListOutput | ConvertFrom-Json)
    $hasSessionSecret = [bool]($secretList | Where-Object { $_.name -eq 'APP_SESSION_SECRET' } | Select-Object -First 1)
    if (-not $hasSessionSecret) {
        $secretBytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($secretBytes) } finally { $rng.Dispose() }
        $sessionSecret = ([BitConverter]::ToString($secretBytes)).Replace('-', '').ToLowerInvariant()
        $sessionSecret | npx wrangler secret put APP_SESSION_SECRET --config $Config
        if ($LASTEXITCODE -ne 0) { throw 'Saving APP_SESSION_SECRET failed' }
    } else {
        Write-Host 'Existing APP_SESSION_SECRET preserved; browser-owned D1 records remain linked.'
    }
    Invoke-Npx @('wrangler','deploy','--dry-run','--config',$Config)
    Invoke-Npx @('wrangler','deploy','--config',$Config)
} finally { Pop-Location }

Write-Host 'Cloudflare hosted edition is ready.' -ForegroundColor Green
