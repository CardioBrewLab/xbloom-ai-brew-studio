#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Directory = [IO.Path]::GetFullPath($PSScriptRoot)
. (Join-Path $Directory '..\..\scripts\windows-compat.ps1')
$Release = Import-XbloomFlatPsd1 (Join-Path $Directory 'xhs-mcp-release.psd1')
$Version = [string]$Release.Version
$ExpectedSha256 = ([string]$Release.Sha256).ToUpperInvariant()
$AssetName = [string]$Release.AssetName
$BundledAsset = [string]$Release.BundledAsset
if (-not $Version -or -not $AssetName -or $ExpectedSha256 -notmatch '^[0-9A-F]{64}$' -or
    -not $BundledAsset) {
    throw 'Xiaohongshu MCP release manifest is invalid.'
}
$Destination = Join-Path $Directory 'xiaohongshu-mcp.exe'
$Temporary = Join-Path $Directory 'xiaohongshu-mcp.download.exe'
$BundledPath = [IO.Path]::GetFullPath((Join-Path $Directory $BundledAsset))
$Url = if ($env:XBLOOM_XHS_MCP_URL) { $env:XBLOOM_XHS_MCP_URL.Trim() } else { '' }
if ($Url -and $Url -notmatch '^https://') { throw 'Xiaohongshu MCP download URL must use HTTPS.' }

foreach ($path in @($Directory, $Destination, $Temporary)) {
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Xiaohongshu MCP install path contains a reparse point: $path"
        }
    }
}

if (Test-Path -LiteralPath $Destination) {
    $currentHash = (Get-XbloomSha256 $Destination).ToUpperInvariant()
    if ($currentHash -eq $ExpectedSha256) {
        Write-Host "Xiaohongshu MCP $Version is ready."
        exit 0
    }
}

if (Test-Path -LiteralPath $BundledPath -PathType Leaf) {
    Copy-Item -LiteralPath $BundledPath -Destination $Temporary -Force
} elseif ($Url) {
    Invoke-WebRequest -Uri $Url -OutFile $Temporary -UseBasicParsing
} else {
    throw 'The checksum-pinned Xiaohongshu MCP bundle is missing from this release package.'
}
$downloadHash = (Get-XbloomSha256 $Temporary).ToUpperInvariant()
if ($downloadHash -ne $ExpectedSha256) {
    Remove-Item -LiteralPath $Temporary -Force
    throw 'Xiaohongshu MCP download checksum mismatch.'
}

if (Test-Path -LiteralPath $Destination) {
    $backup = Join-Path $Directory ("xiaohongshu-mcp.unverified-{0}.exe" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $Destination -Destination $backup
}
Move-Item -LiteralPath $Temporary -Destination $Destination
Write-Host "Xiaohongshu MCP $Version installed and checksum verified."
