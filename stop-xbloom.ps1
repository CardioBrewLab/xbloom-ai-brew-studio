#requires -Version 5.1
# xBloom AI - stop this checkout's hidden watchdog and local services.
# ASCII-only (encoding-safe).
$ErrorActionPreference = 'SilentlyContinue'
$ROOT = $PSScriptRoot
if (-not $ROOT) { $ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ROOT = [IO.Path]::GetFullPath($ROOT)
$logFile = Join-Path $ROOT 'data\xbloom-watchdog.log'
$watchdogPath = [IO.Path]::GetFullPath((Join-Path $ROOT 'watchdog-xbloom.ps1'))
$launcherPath = [IO.Path]::GetFullPath((Join-Path $ROOT 'launch-xbloom.vbs'))
$xhsStartPath = [IO.Path]::GetFullPath((Join-Path $ROOT 'tools\xhs-mcp\start-xhs-mcp.ps1'))
$xhsExecutable = [IO.Path]::GetFullPath((Join-Path $ROOT 'tools\xhs-mcp\xiaohongshu-mcp.exe'))

function Read-LocalPort {
    param([string]$Name, [int]$Fallback)
    $envFile = Join-Path $ROOT '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { return $Fallback }
    $line = Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } |
        Select-Object -Last 1
    if (-not $line) { return $Fallback }
    $raw = (($line -split '=', 2)[1] -split '#', 2)[0].Trim()
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) {
        return $parsed
    }
    return $Fallback
}

$serverPort = Read-LocalPort -Name 'PORT' -Fallback 8787
$webPort = Read-LocalPort -Name 'WEB_PORT' -Fallback 5180
$servicePorts = @($serverPort, $webPort)

function Log($m) {
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $m
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { }
    Write-Output $line
}

function Test-CommandContainsPath([string]$CommandLine, [string]$Path) {
    return [bool]($CommandLine -and $CommandLine.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Test-ProjectServiceProcess($Process, [string]$Name) {
    if (-not $Process -or -not $Process.CommandLine -or
        $Process.CommandLine.IndexOf($ROOT, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $false
    }
    if ($Name -eq 'Backend') {
        return ($Process.CommandLine -match '(?i)npm(?:\.cmd)?\s+run\s+dev') -or
            (($Process.CommandLine -match '(?i)tsx') -and ($Process.CommandLine -match '(?i)src[\\/]index\.ts'))
    }
    if ($Name -eq 'Frontend') {
        return ($Process.CommandLine -match '(?i)npx(?:\.cmd)?\s+vite') -or
            (($Process.CommandLine -match '(?i)(?:^|[\\/\s])vite(?:\.js)?(?:[\s"'']|$)') -and
                ($Process.CommandLine -match ('(?i)--port\s+' + [regex]::Escape([string]$webPort))))
    }
    return $false
}

function Test-ExactExecutablePath($Process, [string]$Path) {
    if (-not $Process -or -not $Process.ExecutablePath) { return $false }
    try {
        return [String]::Equals(
            [IO.Path]::GetFullPath($Process.ExecutablePath),
            $Path,
            [StringComparison]::OrdinalIgnoreCase
        )
    } catch { return $false }
}

# 1) stop watchdog + launcher first, so they won't restart the services again
$wd = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    ((Test-CommandContainsPath $_.CommandLine $watchdogPath) -or
        (Test-CommandContainsPath $_.CommandLine $launcherPath) -or
        (Test-CommandContainsPath $_.CommandLine $xhsStartPath))
}
foreach ($p in $wd) {
    Log ("Stopping watchdog/launcher pid " + $p.ProcessId)
    & taskkill.exe /F /T /PID $p.ProcessId 2>$null | Out-Null
}
Start-Sleep -Milliseconds 800

# 2) stop the exact cmd launch roots first so taskkill /T reaches npm/tsx/vite
# descendants. Killing only a listener would leave the watch parent alive and
# it could immediately recreate that listener.
$serviceLaunchers = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        (Test-ProjectServiceProcess $_ 'Backend') -or (Test-ProjectServiceProcess $_ 'Frontend')
    })
foreach ($launcher in $serviceLaunchers) {
    Log ("Stopping xBloom service tree from launcher pid " + $launcher.ProcessId)
    & taskkill.exe /F /T /PID $launcher.ProcessId 2>$null | Out-Null
}
Start-Sleep -Milliseconds 800

# Then handle any orphan listeners on the configured backend / frontend ports.
# A path match alone is insufficient: each command line must also match that
# service's real entry point, protecting against PID reuse and unrelated apps.
$serviceDefinitions = @(
    @{ Name='Backend'; Port=$serverPort },
    @{ Name='Frontend'; Port=$webPort }
)
$connections = @(Get-NetTCPConnection -LocalPort $servicePorts -State Listen -ErrorAction SilentlyContinue)
foreach ($id in @($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    $ownedService = $null
    foreach ($definition in $serviceDefinitions) {
        $ownsMatchingPort = @($connections | Where-Object {
            $_.OwningProcess -eq $id -and $_.LocalPort -eq $definition.Port
        }).Count -gt 0
        if ($ownsMatchingPort -and (Test-ProjectServiceProcess $proc $definition.Name)) {
            $ownedService = $definition.Name
            break
        }
    }
    if ($ownedService) {
        Log ("Stopping xBloom " + $ownedService + " listener pid " + $id)
        & taskkill.exe /F /T /PID $id 2>$null | Out-Null
    } else {
        Log ("Skipping pid " + $id + " on configured ports: command does not match this checkout's service entry point.")
    }
}
Start-Sleep -Milliseconds 800

# 3) stop only the Xiaohongshu MCP executable installed by this checkout.
$xhsProcesses = @(Get-CimInstance Win32_Process -Filter "Name='xiaohongshu-mcp.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-ExactExecutablePath $_ $xhsExecutable })
foreach ($process in $xhsProcesses) {
    Log ("Stopping project-owned Xiaohongshu MCP pid " + $process.ProcessId)
    & taskkill.exe /F /T /PID $process.ProcessId 2>$null | Out-Null
}
Start-Sleep -Milliseconds 800

# SearXNG and Docker Desktop are user-managed external services. The watchdog
# may request that they start, but the stop command deliberately leaves them up.

# 4) report
$rest = Get-NetTCPConnection -LocalPort $servicePorts -State Listen -ErrorAction SilentlyContinue
if ($rest) {
    Log "NOTE: ports still listening after stop (may be other apps, not xBloom):"
    $rest | Format-Table -AutoSize | Out-String | Write-Output
} else {
    Log ("Stopped. xBloom ports " + ($servicePorts -join ' / ') + " are free.")
}

exit 0
