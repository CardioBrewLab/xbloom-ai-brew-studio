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
