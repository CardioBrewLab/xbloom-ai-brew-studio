[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root ".venv-ble"
$Python = Join-Path $Venv "Scripts\python.exe"
$Requirements = Join-Path $Root "server\python\requirements-ble.txt"

if (-not (Test-Path -LiteralPath $Requirements -PathType Leaf)) {
    throw "BLE requirements file is missing: $Requirements"
}

if (-not (Test-Path -LiteralPath $Python)) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        & $launcher.Source -3 -m venv $Venv
    } else {
        $launcher = Get-Command python -ErrorAction SilentlyContinue
        if (-not $launcher) {
            throw "Python 3.10+ is required for the optional Windows BLE device lab."
        }
        & $launcher.Source -m venv $Venv
    }
    if ($LASTEXITCODE -ne 0) { throw "Creating the BLE Python environment failed." }
}
& $Python -m pip install --disable-pip-version-check --requirement $Requirements
if ($LASTEXITCODE -ne 0) { throw "Installing BLE helper dependencies failed." }
$Probe = '{"command":"probe"}' | & $Python (Join-Path $Root "server\python\xbloom_ble_helper.py")
if ($LASTEXITCODE -ne 0 -or $Probe -notmatch '"ok":true') {
    throw "BLE helper self-check failed: $Probe"
}

Write-Host "xBloom native BLE helper is ready: $Python"
