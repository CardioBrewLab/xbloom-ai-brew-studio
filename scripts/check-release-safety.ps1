[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-CandidateFiles {
    $gitRoot = (& git -C $Root rev-parse --show-toplevel 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $gitRoot) {
        $resolvedGitRoot = [IO.Path]::GetFullPath($gitRoot.Trim())
        if ($resolvedGitRoot.TrimEnd('\') -eq $Root.TrimEnd('\')) {
            # Inspect both the index and every non-ignored untracked file. This
            # makes the gate effective before the first commit and before a new
            # release artifact is staged.
            return @(& git -C $Root ls-files --cached --others --exclude-standard | Sort-Object -Unique | ForEach-Object { Join-Path $Root $_ })
        }
    }

    $ignoredDirectories = @('node_modules', 'dist', '.runtime', '.codex', 'data', '.git')
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\')
        $segments = $relative -split '[\\/]'
        -not ($segments | Where-Object { $ignoredDirectories -contains $_ })
    } | Select-Object -ExpandProperty FullName)
}

function Relative-Path([string]$Path) {
    return $Path.Substring($Root.Length).TrimStart('\').Replace('\', '/')
}

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
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

function Get-ReleaseManifestSha256([string]$ManifestPath) {
    # Keep this release gate compatible with the minimal Windows PowerShell
    # environments used by GitHub runners and older one-click-install hosts.
    # Parse the deliberately simple repo-controlled data shape without loading
    # or executing PSD1 content. Reject comments, here-strings, duplicate keys
    # and any future syntax that this release gate does not explicitly support.
    $lines = @([IO.File]::ReadAllLines($ManifestPath) | Where-Object { $_.Trim().Length -gt 0 })
    if ($lines.Count -lt 3 -or $lines[0].Trim() -ne '@{' -or $lines[$lines.Count - 1].Trim() -ne '}') {
        throw "Invalid release manifest envelope: $ManifestPath"
    }

    $manifest = @{}
    for ($index = 1; $index -lt ($lines.Count - 1); $index++) {
        $match = [regex]::Match($lines[$index], '^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*''([^'']*)''\s*$')
        if (-not $match.Success -or $manifest.ContainsKey($match.Groups[1].Value)) {
            throw "Invalid release manifest entry at line $($index + 1): $ManifestPath"
        }
        $manifest[$match.Groups[1].Value] = $match.Groups[2].Value
    }

    $sha256 = [string]$manifest['Sha256']
    if ($sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw "Missing or invalid Sha256 in release manifest: $ManifestPath"
    }
    return $sha256.ToUpperInvariant()
}

$files = @(Get-CandidateFiles)
$problems = New-Object System.Collections.Generic.List[string]

$forbiddenPaths = @(
    '(^|/)\.env($|\.)',
    '^data/',
    '^\.runtime/',
    '^node_modules/',
    '(^|/)dist/',
    '^tools/xhs-mcp/.*\.exe$',
    '^tools/xhs-mcp/.*\.zip$',
    '^tools/xhs-mcp/cookies\.json',
    '^tools/xhs-mcp/.*-result\.json$',
    '^tools/xhs-mcp/qrcode',
    '^tools/xhs-mcp/.*\.log$',
    '^tools/xhs-mcp/(data|browser-data|runtime)/',
    '(^|/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|pfx|p12|jks|keystore))$',
    '(^|/)(?:credentials|secrets)(?:\.[^/]+)?$'
)

foreach ($file in $files) {
    $relative = Relative-Path $file
    if ($relative -ieq 'tools/xhs-mcp/bundled/xiaohongshu-mcp-windows-amd64-fixed.exe') {
        $expectedHash = Get-ReleaseManifestSha256 (Join-Path $Root 'tools\xhs-mcp\xhs-mcp-release.psd1')
        $actualHash = Get-FileSha256 $file
        if ($actualHash -ne $expectedHash) {
            $problems.Add("checksum mismatch for bundled MCP executable: $relative")
        }
        continue
    }
    foreach ($pattern in $forbiddenPaths) {
        if ($relative -ieq '.env.example') { continue }
        if ($relative -match $pattern) {
            $problems.Add("forbidden tracked path: $relative")
            break
        }
    }
}

$textExtensions = @(
    '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.ps1', '.bat',
    '.vbs', '.yml', '.yaml', '.html', '.css', '.svg', '.env', '.gitignore',
    '.gitattributes', '.editorconfig', '.psd1', '.toml', '.ini', '.xml', '.sh',
    '.properties', '.config', '.conf'
)
$secretPatterns = [ordered]@{
    'personal author footer' = 'Designed\s*&\s*Crafted|\u674E\u5EB7\u878D'
    'personal QQ email' = '[A-Za-z0-9._%+-]+@qq\.com'
    'private key block' = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
    'GitHub token' = '(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})'
    'AWS access key' = 'AKIA[0-9A-Z]{16}'
    'API key with sk prefix' = 'sk-[A-Za-z0-9_-]{20,}'
    'Google API key' = 'AIza[0-9A-Za-z_-]{35}'
    'Slack token' = 'xox[baprs]-[0-9A-Za-z-]{10,}'
    'npm access token' = 'npm_[A-Za-z0-9]{36}'
    'GitLab access token' = 'glpat-[A-Za-z0-9_-]{20,}'
    'Stripe live secret' = 'sk_live_[0-9A-Za-z]{16,}'
    'URL with embedded credentials' = 'https?://[^/\s:@]+:[^@\s/]+@'
    'absolute Windows user path' = '[A-Za-z]:[\\/]Users[\\/][^\s"''`]+'
}

foreach ($file in $files) {
    $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
    $leaf = [IO.Path]::GetFileName($file).ToLowerInvariant()
    if (($textExtensions -notcontains $extension) -and ($leaf -notin @('.gitignore', '.gitattributes', '.editorconfig'))) {
        continue
    }
    try {
        $content = [IO.File]::ReadAllText($file)
    } catch {
        $problems.Add("unreadable tracked text file: $(Relative-Path $file)")
        continue
    }
    # Reserved .example hosts are used to test URL validation without carrying real credentials.
    $content = $content -replace 'https?://[^/\s:@]+:[^@\s/]+@(?:[A-Za-z0-9-]+\.)*example(?:/[^\s"''`]*)?', ''
    foreach ($entry in $secretPatterns.GetEnumerator()) {
        if ($content -match $entry.Value) {
            $problems.Add("$($entry.Key): $(Relative-Path $file)")
        }
    }
}

if ($problems.Count -gt 0) {
    Write-Host 'Release safety check failed:' -ForegroundColor Red
    $problems | Sort-Object -Unique | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host "Release safety check passed: $($files.Count) files inspected; no local sessions, runtime artifacts or common secret patterns found."
