#requires -Version 5.1

# Shared Windows PowerShell helpers for the one-click installer and its
# regression tests. These deliberately use .NET APIs instead of optional
# PowerShell modules so a clean Windows host has the same execution path as CI.

function Get-XbloomSha256([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $stream = [IO.File]::OpenRead($fullPath)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-XbloomDriveFormat([string]$Path) {
    try {
        $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
        return ([IO.DriveInfo]::new($root)).DriveFormat
    } catch {
        return 'Unknown'
    }
}

function Get-XbloomEnvValue([string]$Root, [string]$Name) {
    $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        return $processValue.Trim()
    }

    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return ''
    }

    foreach ($line in @(Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue)) {
        if ($line -notmatch ('^\s*' + [regex]::Escape($Name) + '\s*=')) { continue }
        $raw = (($line -split '=', 2)[1] -replace '\s+#.*$', '').Trim()
        $singleQuote = [char]39
        if ($raw.Length -ge 2 -and
            (($raw[0] -eq '"' -and $raw[$raw.Length - 1] -eq '"') -or
             ($raw[0] -eq $singleQuote -and $raw[$raw.Length - 1] -eq $singleQuote))) {
            return $raw.Substring(1, $raw.Length - 2)
        }
        return $raw
    }
    return ''
}

function Test-XbloomDefaultLoopbackEndpoint([string]$Value, [int]$Port) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    try {
        $uri = [Uri]$Value.Trim()
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'http' -or $uri.Port -ne $Port -or $uri.UserInfo) {
            return $false
        }
        return @('127.0.0.1', 'localhost', '::1') -contains $uri.Host.ToLowerInvariant()
    } catch {
        return $false
    }
}

function Protect-XbloomPrivatePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Directory,
        [string]$DriveFormat = ''
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($Directory) {
        New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $fullPath)) {
        throw "Private path does not exist: $fullPath"
    }
    $item = Get-Item -LiteralPath $fullPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Private path contains a reparse point: $fullPath"
    }

    if (-not $DriveFormat) { $DriveFormat = Get-XbloomDriveFormat $fullPath }
    if ($DriveFormat -notin @('NTFS', 'ReFS')) {
        return $false
    }

    $acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        $acl.RemoveAccessRuleAll($existingRule)
    }

    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $identities = @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null),
        [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
    )
    foreach ($identity in $identities) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            $fullControl,
            $inheritance,
            $propagation,
            $allow
        )
        $acl.AddAccessRule($rule)
    }
    $item.SetAccessControl($acl)
    return $true
}

function Protect-XbloomPrivateDirectory([string]$Path, [string]$DriveFormat = '') {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $DriveFormat) { $DriveFormat = Get-XbloomDriveFormat $fullPath }
    if (-not (Protect-XbloomPrivatePath -Path $fullPath -Directory -DriveFormat $DriveFormat)) {
        return $false
    }

    foreach ($child in @(Get-ChildItem -LiteralPath $fullPath -Force -Recurse -ErrorAction Stop)) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Private directory contains a reparse point: $($child.FullName)"
        }
        [void](Protect-XbloomPrivatePath -Path $child.FullName -Directory:$child.PSIsContainer -DriveFormat $DriveFormat)
    }
    return $true
}

function Invoke-XbloomOptionalStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Action
    )

    try {
        $global:LASTEXITCODE = 0
        & $Action
        if ($global:LASTEXITCODE -ne 0) {
            throw "exit code $global:LASTEXITCODE"
        }
        return $true
    } catch {
        Write-Warning ("Optional " + $Name + " setup was skipped: " + $_.Exception.Message)
        return $false
    }
}

function ConvertTo-XbloomProcessArgument([string]$Value) {
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append((('\' * (($backslashes * 2) + 1)) -join ''))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append((('\' * $backslashes) -join ''))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append((('\' * ($backslashes * 2)) -join ''))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Start-XbloomHiddenProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WorkDir,
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$StandardOutput,
        [Parameter(Mandatory)][string]$StandardError
    )

    foreach ($logPath in @($StandardOutput, $StandardError)) {
        $parent = Split-Path -Parent $logPath
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (Test-Path -LiteralPath $logPath) {
            Clear-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
        }
    }

    $argumentLine = (($Arguments | ForEach-Object { ConvertTo-XbloomProcessArgument ([string]$_) }) -join ' ')
    return Start-Process -FilePath $FilePath `
        -ArgumentList $argumentLine `
        -WorkingDirectory $WorkDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StandardOutput `
        -RedirectStandardError $StandardError `
        -PassThru
}

function Import-XbloomFlatPsd1([string]$Path) {
    # xhs-mcp-release.psd1 is a deliberately flat, repo-controlled manifest.
    # Parsing this small grammar avoids executing PSD1 content and does not
    # depend on Import-PowerShellDataFile being present on a minimal host.
    $fullPath = [IO.Path]::GetFullPath($Path)
    $lines = @([IO.File]::ReadAllLines($fullPath) | Where-Object { $_.Trim().Length -gt 0 })
    if ($lines.Count -lt 3 -or $lines[0].Trim() -ne '@{' -or $lines[$lines.Count - 1].Trim() -ne '}') {
        throw "Invalid flat PowerShell data manifest envelope: $fullPath"
    }

    $manifest = @{}
    for ($index = 1; $index -lt ($lines.Count - 1); $index++) {
        $match = [regex]::Match($lines[$index], '^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*''([^'']*)''\s*$')
        $key = if ($match.Success) { $match.Groups[1].Value } else { '' }
        if (-not $match.Success -or $manifest.ContainsKey($key)) {
            throw "Invalid flat PowerShell data manifest entry at line $($index + 1): $fullPath"
        }
        $manifest[$key] = $match.Groups[2].Value
    }
    return $manifest
}

function Expand-XbloomZipArchive([string]$ArchivePath, [string]$DestinationPath) {
    $archive = [IO.Path]::GetFullPath($ArchivePath)
    $destination = [IO.Path]::GetFullPath($DestinationPath)
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        throw "ZIP archive does not exist: $archive"
    }
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
        throw "ZIP destination does not exist: $destination"
    }
    if (@(Get-ChildItem -LiteralPath $destination -Force).Count -ne 0) {
        throw "ZIP destination must be empty: $destination"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $relative = $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar)
            if ([IO.Path]::IsPathRooted($relative)) {
                throw "ZIP archive contains a rooted path: $($entry.FullName)"
            }
            $target = [IO.Path]::GetFullPath((Join-Path $destination $relative))
            if ($target -ne $destination -and -not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "ZIP archive contains a path outside the destination: $($entry.FullName)"
            }
        }
    } finally {
        $zip.Dispose()
    }

    # Expand-Archive in the inbox Windows PowerShell 5.1 module can fail while
    # cleaning its own extraction list. ZipFile avoids that host-specific path.
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
}
