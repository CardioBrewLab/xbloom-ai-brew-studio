#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Output = (Join-Path $PSScriptRoot 'xiaohongshu-mcp-windows-amd64-fixed.exe'),
    [string]$WorkDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'xbloom-xhs-mcp-build')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$sourceVersion = 'v2.4.3'
$sourceUrl = "https://github.com/xpzouying/xiaohongshu-mcp/archive/refs/tags/$sourceVersion.zip"
$archive = Join-Path $WorkDirectory 'xiaohongshu-mcp-source.zip'
$sourceRoot = Join-Path $WorkDirectory 'xiaohongshu-mcp-2.4.3'
$vendorRoot = Join-Path $WorkDirectory 'headless_browser'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw 'Go 1.24 or newer is required to build the Windows-fixed MCP release asset.'
}

$resolvedWork = [IO.Path]::GetFullPath($WorkDirectory)
$resolvedOutput = [IO.Path]::GetFullPath($Output)
if ($resolvedWork -eq [IO.Path]::GetPathRoot($resolvedWork)) {
    throw 'WorkDirectory must not be a drive root.'
}

if (Test-Path -LiteralPath $resolvedWork) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force
}
New-Item -ItemType Directory -Path $resolvedWork -Force | Out-Null

Invoke-WebRequest -Uri $sourceUrl -OutFile $archive -UseBasicParsing
Expand-Archive -LiteralPath $archive -DestinationPath $resolvedWork -Force
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'go.mod'))) {
    throw 'The pinned Xiaohongshu MCP source archive has an unexpected layout.'
}

$moduleJson = (& go mod download -json 'github.com/xpzouying/headless_browser@v0.4.0' | Out-String) | ConvertFrom-Json
if (-not $moduleJson.Dir -or -not (Test-Path -LiteralPath $moduleJson.Dir)) {
    throw 'The pinned headless_browser module was not resolved.'
}
Copy-Item -LiteralPath $moduleJson.Dir -Destination $vendorRoot -Recurse
Get-ChildItem -LiteralPath $vendorRoot -Recurse -Force |
    Where-Object { -not $_.PSIsContainer } |
    ForEach-Object { $_.IsReadOnly = $false }

$browserFile = Join-Path $vendorRoot 'headless_browser.go'
$browserSource = Get-Content -LiteralPath $browserFile -Raw -Encoding UTF8
$needle = @'
	l := launcher.New().
		Headless(cfg.Headless).
		Set("--no-sandbox")
'@
$replacement = @'
	l := launcher.New().
		Headless(cfg.Headless).
		Set("--no-sandbox")

	// The MCP service owns the browser lifecycle. On Windows, launching Chrome
	// directly also avoids the leakless helper waiting forever for a child PID.
	if runtime.GOOS == "windows" {
		l = l.Leakless(false)
	}
'@
if (-not $browserSource.Contains($needle)) {
    throw 'The pinned headless_browser launcher block changed; review the patch before building.'
}
$browserSource = $browserSource.Replace($needle, $replacement)
[IO.File]::WriteAllText($browserFile, $browserSource, (New-Object Text.UTF8Encoding($false)))

Push-Location $sourceRoot
try {
    & go mod edit "-replace=github.com/xpzouying/headless_browser=$vendorRoot"
    if ($LASTEXITCODE -ne 0) { throw 'go mod edit failed.' }
    & gofmt -w $browserFile
    if ($LASTEXITCODE -ne 0) { throw 'gofmt failed.' }
    # The upstream cookies test only redirects TMPDIR, which os.TempDir does
    # not read on Windows. Browser/config tests cover the patched build path.
    & go test ./browser ./configs
    if ($LASTEXITCODE -ne 0) { throw 'Pinned MCP unit tests failed.' }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($resolvedOutput)) -Force | Out-Null
    & go build -trimpath -ldflags '-s -w -X main.version=v2.4.3-windows-fix1' -o $resolvedOutput .
    if ($LASTEXITCODE -ne 0) { throw 'Windows-fixed MCP build failed.' }
} finally {
    Pop-Location
}

$hash = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToUpperInvariant()
Write-Host "Built $resolvedOutput"
Write-Host "SHA256 $hash"
