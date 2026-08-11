#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ArtifactPath = '',
    [string]$WorkRoot = '',
    [switch]$KeepWorkRoot,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$SourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ReportDirectory = Join-Path $SourceRoot '.codex'
$ReportPath = Join-Path $ReportDirectory 'clean-install-report.json'
. (Join-Path $PSScriptRoot 'windows-compat.ps1')
$serverProcess = $null
$result = [ordered]@{
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    source = $SourceRoot
    artifact = if ($ArtifactPath) { [IO.Path]::GetFullPath($ArtifactPath) } else { 'tracked working tree' }
    installRoot = $null
    volumeFormat = $null
    portableNode = $false
    dependencies = $false
    build = $false
    xhsBinary = $false
    blankConfiguration = $false
    privateStateAbsent = $false
    tests = if ($SkipTests) { 'skipped' } else { 'pending' }
    httpSmoke = $false
    status = 'running'
}

function Assert-Condition([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Test-PortFree([int]$Port) {
    try {
        return -not [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return $true
    }
}

function Get-FreePort {
    for ($i = 0; $i -lt 50; $i++) {
        $candidate = Get-Random -Minimum 21000 -Maximum 49000
        if (Test-PortFree $candidate) { return $candidate }
    }
    throw 'No free loopback port was found for the clean-install smoke test.'
}

function Copy-ReleaseWorkingTree([string]$Destination) {
    $files = @(& git -C $SourceRoot ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) {
        throw 'Git did not return the release file list.'
    }
    foreach ($relative in $files) {
        $source = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $target = Join-Path $Destination $relative
        $parent = Split-Path -Parent $target
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

function Resolve-ExtractedRoot([string]$Directory) {
    if ((Test-Path -LiteralPath (Join-Path $Directory 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $Directory 'install-windows.bat'))) {
        return [IO.Path]::GetFullPath($Directory)
    }
    $matches = @(Get-ChildItem -LiteralPath $Directory -Directory | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.FullName 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'install-windows.bat'))
    })
    if ($matches.Count -ne 1) { throw 'The release archive root was not recognized.' }
    return [IO.Path]::GetFullPath($matches[0].FullName)
}

function Set-EnvValue([string]$Path, [string]$Name, [string]$Value) {
    $content = [IO.File]::ReadAllText($Path)
    $pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
    $replacement = $Name + '=' + $Value
    if ($content -match $pattern) {
        $content = [regex]::Replace($content, $pattern, $replacement)
    } else {
        $content = $content.TrimEnd() + [Environment]::NewLine + $replacement + [Environment]::NewLine
    }
    [IO.File]::WriteAllText($Path, $content, (New-Object Text.UTF8Encoding($false)))
}

function Wait-HttpReady([string]$Uri, [int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Uri -TimeoutSec 3
        } catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for $Uri"
}

try {
    New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
    if (-not $WorkRoot) {
        $WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ("xbloom-clean-install-{0}-cross-pc path" -f $PID)
    }
    $WorkRoot = [IO.Path]::GetFullPath($WorkRoot)
    Assert-Condition ($WorkRoot.TrimEnd('\') -ne $SourceRoot.TrimEnd('\')) 'WorkRoot must be separate from the source checkout.'
    if (Test-Path -LiteralPath $WorkRoot) {
        $leaf = Split-Path -Leaf $WorkRoot
        Assert-Condition ($leaf -like 'xbloom-clean-install-*') 'Existing WorkRoot name is outside the clean-install test namespace.'
        Remove-Item -LiteralPath $WorkRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

    if ($ArtifactPath) {
        $archive = [IO.Path]::GetFullPath($ArtifactPath)
        Assert-Condition (Test-Path -LiteralPath $archive -PathType Leaf) "Release archive does not exist: $archive"
        Expand-XbloomZipArchive $archive $WorkRoot
        $InstallRoot = Resolve-ExtractedRoot $WorkRoot
    } else {
        $InstallRoot = Join-Path $WorkRoot 'xBloom AI Brew Studio fresh install'
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        Copy-ReleaseWorkingTree $InstallRoot
    }
    $result.installRoot = $InstallRoot
    try {
        $result.volumeFormat = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($InstallRoot))).DriveFormat
    } catch {
        $result.volumeFormat = 'Unknown'
    }

    foreach ($privatePath in @('.env', 'data', '.runtime', 'node_modules', 'server\dist', 'web\dist', 'shared\dist', 'tools\xhs-mcp\runtime')) {
        Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $privatePath))) "Release package contains generated/private path: $privatePath"
    }

    $installer = Join-Path $InstallRoot 'scripts\install-windows.ps1'
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -SkipLaunch -SkipShortcut -SkipBle
    if ($LASTEXITCODE -ne 0) { throw "Installer exited with code $LASTEXITCODE" }

    $nodeExe = Join-Path $InstallRoot '.runtime\node\node.exe'
    Assert-Condition (Test-Path -LiteralPath $nodeExe -PathType Leaf) 'Portable Node.js was not installed.'
    Assert-Condition ((& $nodeExe --version).Trim() -eq 'v24.18.0') 'Portable Node.js version differs from the pinned installer version.'
    $result.portableNode = $true

    foreach ($required in @('node_modules', 'node_modules\express', 'node_modules\vite', 'node_modules\@xbloom\shared')) {
        Assert-Condition (Test-Path -LiteralPath (Join-Path $InstallRoot $required) -PathType Container) "Dependency directory is missing: $required"
    }
    $result.dependencies = $true
    foreach ($required in @('server\dist\index.js', 'web\dist\index.html', 'shared\dist\recipe-schema.js')) {
        Assert-Condition (Test-Path -LiteralPath (Join-Path $InstallRoot $required) -PathType Leaf) "Build output is missing: $required"
    }
    $result.build = $true

    $manifest = Import-XbloomFlatPsd1 (Join-Path $InstallRoot 'tools\xhs-mcp\xhs-mcp-release.psd1')
    $xhsExe = Join-Path $InstallRoot 'tools\xhs-mcp\xiaohongshu-mcp.exe'
    Assert-Condition (Test-Path -LiteralPath $xhsExe -PathType Leaf) 'The checksum-pinned Xiaohongshu MCP executable was not installed.'
    $xhsHash = (Get-XbloomSha256 $xhsExe).ToUpperInvariant()
    Assert-Condition ($xhsHash -eq ([string]$manifest.Sha256).ToUpperInvariant()) 'The installed Xiaohongshu MCP checksum differs from the release manifest.'
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'tools\xhs-mcp\start-xhs-mcp.ps1') -PrepareOnly
    if ($LASTEXITCODE -ne 0) { throw "Preparing the Xiaohongshu MCP runtime exited with code $LASTEXITCODE" }
    $result.xhsBinary = $true

    $envPath = Join-Path $InstallRoot '.env'
    Assert-Condition (Test-Path -LiteralPath $envPath -PathType Leaf) 'Installer did not create .env from the blank template.'
    $envText = [IO.File]::ReadAllText($envPath)
    foreach ($name in @('LLM_BASE_URL', 'LLM_API_KEY', 'LLM_FALLBACK_API_KEY', 'XBLOOM_EMAIL', 'XBLOOM_PASSWORD', 'FIRECRAWL_API_KEY')) {
        Assert-Condition ($envText -match ('(?m)^' + [regex]::Escape($name) + '=$')) "Fresh .env carries a value for $name"
    }
    $result.blankConfiguration = $true
    foreach ($privatePath in @('data\session.json', 'data\llm-settings.json', 'tools\xhs-mcp\runtime\cookies.json')) {
        Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $InstallRoot $privatePath))) "Fresh install created unexpected private state: $privatePath"
    }
    $result.privateStateAbsent = $true

    if (-not $SkipTests) {
        $tsxCli = Join-Path $InstallRoot 'node_modules\tsx\dist\cli.mjs'
        Push-Location (Join-Path $InstallRoot 'server')
        try {
            & $nodeExe $tsxCli --test 'test/*.test.ts'
            if ($LASTEXITCODE -ne 0) { throw "Isolated server tests exited with code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        Push-Location (Join-Path $InstallRoot 'web')
        try {
            & $nodeExe $tsxCli --test 'test/*.test.ts'
            if ($LASTEXITCODE -ne 0) { throw "Isolated web tests exited with code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        $result.tests = 'passed'
    }

    $serverPort = Get-FreePort
    $xhsPort = Get-FreePort
    Set-EnvValue $envPath 'PORT' ([string]$serverPort)
    Set-EnvValue $envPath 'XHS_MCP_URL' ("http://127.0.0.1:{0}" -f $xhsPort)
    Set-EnvValue $envPath 'SEARXNG_URL' ("http://127.0.0.1:{0}" -f (Get-FreePort))
    $stdout = Join-Path $WorkRoot 'server.stdout.log'
    $stderr = Join-Path $WorkRoot 'server.stderr.log'
    $serverProcess = Start-Process -FilePath $nodeExe -ArgumentList 'server/dist/index.js' -WorkingDirectory $InstallRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $status = Wait-HttpReady ("http://127.0.0.1:{0}/api/status" -f $serverPort)
    Assert-Condition ([bool]$status.ok) 'Fresh backend status did not report ok.'
    $releaseVersion = [string](Get-Content -LiteralPath (Join-Path $InstallRoot 'package.json') -Raw | ConvertFrom-Json).version
    Assert-Condition ([string]$status.version -eq $releaseVersion) 'Fresh backend version differs from the release version.'
    $html = (Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $serverPort) -UseBasicParsing -TimeoutSec 5).Content
    Assert-Condition ($html -match 'xBloom AI Brew Studio') 'Built desktop UI was not served by the fresh backend.'
    $xhsStatus = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/xhs/status" -f $serverPort) -TimeoutSec 10
    Assert-Condition (-not [bool]$xhsStatus.loggedIn) 'Fresh Xiaohongshu status unexpectedly contains a signed-in session.'
    $result.httpSmoke = $true
    $result.status = 'passed'
} catch {
    $result.status = 'failed'
    $result.error = $_.Exception.Message
    throw
} finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(5000) | Out-Null
    }
    $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    if (-not $KeepWorkRoot -and $result.status -eq 'passed' -and (Test-Path -LiteralPath $WorkRoot)) {
        $leaf = Split-Path -Leaf $WorkRoot
        if ($leaf -like 'xbloom-clean-install-*') {
            Remove-Item -LiteralPath $WorkRoot -Recurse -Force
        }
    }
}

Write-Host "Clean-install regression passed. Report: $ReportPath" -ForegroundColor Green
