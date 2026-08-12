#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipLaunch,
    [switch]$SkipShortcut,
    [switch]$SkipBle,
    [switch]$SkipXhs
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = Join-Path $Root '.runtime'
$NodeHome = Join-Path $RuntimeRoot 'node'
$NodeVersion = '24.18.0'
$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeArchiveUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName"
$ExpectedNodeSha256 = '0AE68406B42D7725661DA979B1403EC9926DA205C6770827F33AAC9D8F26E821'
. (Join-Path $PSScriptRoot 'windows-compat.ps1')

$ProjectDriveFormat = Get-XbloomDriveFormat $Root
if ($ProjectDriveFormat -notin @('NTFS', 'ReFS')) {
    Write-Warning ("SECURITY WARNING: the project volume is " + $ProjectDriveFormat + " and has no reliable per-user Windows ACLs. Keep this directory private to the current Windows account; .env, data, cookies and deployment state may be readable by other accounts.")
}

function Assert-ProjectPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = $Root.TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside the project directory: $full"
    }
    return $full
}

function Assert-NoProjectReparsePoint([string]$Path) {
    $full = Assert-ProjectPath $Path
    $relative = $full.Substring($Root.TrimEnd('\').Length).TrimStart('\')
    $cursor = $Root
    foreach ($part in @($relative -split '\\' | Where-Object { $_ })) {
        $cursor = Join-Path $cursor $part
        if (-not (Test-Path -LiteralPath $cursor)) { break }
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Project runtime path contains a reparse point: $cursor"
        }
    }
    return $full
}

function Download-File([string]$Uri, [string]$Destination) {
    $target = Assert-NoProjectReparsePoint $Destination
    Write-Host "Downloading $Uri"
    Invoke-WebRequest -Uri $Uri -OutFile $target -UseBasicParsing
}

function Install-PortableNode {
    $nodeExe = Join-Path $NodeHome 'node.exe'
    if (Test-Path -LiteralPath $nodeExe) {
        Assert-NoProjectReparsePoint $nodeExe | Out-Null
        $installed = (& $nodeExe --version).TrimStart('v')
        if ($installed -eq $NodeVersion) {
            Write-Host "Node.js v$NodeVersion is ready."
            return
        }
    }

    $safeRuntimeRoot = Assert-NoProjectReparsePoint $RuntimeRoot
    New-Item -ItemType Directory -Path $safeRuntimeRoot -Force | Out-Null
    $archive = Join-Path $RuntimeRoot $NodeArchiveName
    Download-File $NodeArchiveUrl $archive

    $actualHash = (Get-XbloomSha256 $archive).ToUpperInvariant()
    if ($actualHash -ne $ExpectedNodeSha256) { throw "Node.js download checksum mismatch." }

    $extractRoot = Assert-NoProjectReparsePoint (Join-Path $RuntimeRoot 'node-extract')
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath (Assert-NoProjectReparsePoint $extractRoot) -Recurse -Force
    }
    New-Item -ItemType Directory -Path $extractRoot | Out-Null
    Expand-XbloomZipArchive $archive $extractRoot
    $expanded = Assert-NoProjectReparsePoint (Join-Path $extractRoot "node-v$NodeVersion-win-x64")
    if (-not (Test-Path -LiteralPath (Join-Path $expanded 'node.exe'))) {
        throw "Node.js archive layout was not recognized."
    }
    if (Test-Path -LiteralPath $NodeHome) {
        Remove-Item -LiteralPath (Assert-NoProjectReparsePoint $NodeHome) -Recurse -Force
    }
    Move-Item -LiteralPath $expanded -Destination (Assert-NoProjectReparsePoint $NodeHome)
    Remove-Item -LiteralPath (Assert-NoProjectReparsePoint $extractRoot) -Recurse -Force
    Write-Host "Node.js v$NodeVersion installed locally."
}

function Invoke-Npm([string[]]$Arguments) {
    $npm = Join-Path $NodeHome 'npm.cmd'
    & $npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function New-DesktopShortcut {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { return }
    $shortcutPath = Join-Path $desktop 'xBloom AI Brew Studio.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $Root 'start-xbloom.bat'
    $shortcut.WorkingDirectory = $Root
    $shortcut.IconLocation = (Join-Path $Root 'assets\xbloom.ico') + ',0'
    $shortcut.Description = 'Start xBloom AI Brew Studio'
    $shortcut.Save()
    Write-Host "Desktop shortcut created: $shortcutPath"
}

function Protect-InstallPrivateState {
    foreach ($entry in @(
        @{ Path = (Join-Path $Root '.env'); Directory = $false },
        @{ Path = (Join-Path $Root 'data'); Directory = $true },
        @{ Path = (Join-Path $Root 'tools\xhs-mcp\runtime'); Directory = $true },
        @{ Path = (Join-Path $Root 'cloudflare\.wrangler\edge-proxy-secret.txt'); Directory = $false }
    )) {
        if (-not (Test-Path -LiteralPath $entry.Path)) { continue }
        Assert-NoProjectReparsePoint $entry.Path | Out-Null
        if ($entry.Directory) {
            [void](Protect-XbloomPrivateDirectory -Path $entry.Path -DriveFormat $ProjectDriveFormat)
        } else {
            [void](Protect-XbloomPrivatePath -Path $entry.Path -DriveFormat $ProjectDriveFormat)
        }
    }
}

Write-Host ''
Write-Host 'xBloom AI Brew Studio - local Windows setup' -ForegroundColor Cyan
Write-Host "Project: $Root"

Install-PortableNode
$env:PATH = "$NodeHome;$env:PATH"

# npm ci replaces node_modules and the build rewrites dist directories. Reject
# a redirected top-level target before either tool is allowed to mutate it.
foreach ($managedPath in @(
    (Join-Path $Root 'node_modules'),
    (Join-Path $Root 'shared\node_modules'),
    (Join-Path $Root 'server\node_modules'),
    (Join-Path $Root 'web\node_modules'),
    (Join-Path $Root 'shared\dist'),
    (Join-Path $Root 'server\dist'),
    (Join-Path $Root 'web\dist'),
    (Join-Path $Root 'data'),
    (Join-Path $Root 'tools\xhs-mcp')
)) {
    Assert-NoProjectReparsePoint $managedPath | Out-Null
}

$envFile = Join-Path $Root '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $envFile
    Write-Host 'Created a blank local .env file. Model credentials remain user supplied.'
}
New-Item -ItemType Directory -Path (Join-Path $Root 'data') -Force | Out-Null
Protect-InstallPrivateState

Push-Location $Root
try {
    try {
        $driveFormat = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($Root))).DriveFormat
    } catch {
        $driveFormat = 'Unknown'
    }
    $supportsWorkspaceLinks = $driveFormat -in @('NTFS', 'ReFS')
    Write-Host "Installing locked npm dependencies (volume: $driveFormat)..."
    if ($supportsWorkspaceLinks) {
        Invoke-Npm @('ci')
    } else {
        # npm workspaces are directory links. exFAT/FAT cannot host Windows
        # reparse points, so install the same locked dependency graph physically
        # at the root; build:shared then materializes the internal shared package.
        Invoke-Npm @('ci', '--workspaces=false')
    }
    Write-Host 'Building the application...'
    Invoke-Npm @('run', 'build')
} finally {
    Pop-Location
}

if ($SkipXhs) {
    Write-Warning 'Optional Xiaohongshu MCP setup skipped by request.'
} else {
    [void](Invoke-XbloomOptionalStep -Name 'Xiaohongshu MCP helper' -Action {
        $powershell = Join-Path $PSHOME 'powershell.exe'
        & $powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\xhs-mcp\install-xhs-mcp.ps1')
    })
}

# The everyday workflow uploads to the phone App. When Python is already
# available, prepare the optional Windows BLE device lab as part of setup.
$pythonReady = (Get-Command py -ErrorAction SilentlyContinue) -or (Get-Command python -ErrorAction SilentlyContinue)
if ($SkipBle) {
    Write-Host 'Optional BLE device lab setup skipped by request.'
} elseif ($pythonReady) {
    try {
        & (Join-Path $Root 'install-ble.ps1')
    } catch {
        Write-Warning ("Optional BLE device lab setup was skipped: " + $_.Exception.Message)
    }
} else {
    Write-Host 'Optional BLE device lab: install Python 3.10+ later, then run .\install-ble.ps1.'
}

New-Item -ItemType Directory -Path (Join-Path $Root 'data') -Force | Out-Null
if (-not $SkipShortcut) {
    [void](Invoke-XbloomOptionalStep -Name 'desktop shortcut' -Action {
        New-DesktopShortcut
    })
} else {
    Write-Host 'Optional desktop shortcut setup skipped by request.'
}
Protect-InstallPrivateState

Write-Host ''
Write-Host 'Installation completed.' -ForegroundColor Green
Write-Host 'The first app launch may take a few minutes while Xiaohongshu downloads its browser runtime.'
if (-not $SkipLaunch) {
    Start-Process -FilePath (Join-Path $Root 'start-xbloom.bat') -WorkingDirectory $Root
}
