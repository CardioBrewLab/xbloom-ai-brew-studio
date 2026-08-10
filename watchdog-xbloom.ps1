#requires -Version 5.1
# xBloom AI watchdog
#   - Launches backend (server: npm run dev = tsx watch, port 8787) and
#     frontend (web: npx vite --port 5180 --strictPort, port 5180) in HIDDEN windows.
#   - Monitors both ports; auto-restarts whichever dies within a few seconds.
#   - Opens the browser to http://localhost:5180 once the frontend is ready.
#   - Process-ownership aware: only treats a port as "ours" when the listener's
#     CommandLine contains $ROOT (the project path), preventing false positives
#     when another app (e.g. Open Science) occupies the same port.
#   - Single-instance (named mutex). ASCII-only file (encoding-safe).
# Launched hidden by launch-xbloom.vbs. Runs forever until killed.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ROOT = $PSScriptRoot
if (-not $ROOT) { $ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path }

# The one-click installer keeps Node.js inside the project, so launching the app
# never depends on a machine-wide Node installation.
$localNodeHome = Join-Path $ROOT '.runtime\node'
if (Test-Path -LiteralPath (Join-Path $localNodeHome 'node.exe')) {
    $env:PATH = $localNodeHome + ';' + $env:PATH
}

$logDir = Join-Path $ROOT 'data'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile    = Join-Path $logDir 'xbloom-watchdog.log'
$backendLog  = Join-Path $logDir 'xbloom-backend.log'
$frontendLog = Join-Path $logDir 'xbloom-frontend.log'

function Write-Log {
    param([string]$msg)
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch { }
}

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
$webPort    = Read-LocalPort -Name 'WEB_PORT' -Fallback 5180
# Vite reads the same backend target; the default remains 127.0.0.1:8787.
$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:' + $serverPort

# --- SearXNG self-heal (task #79): local SearXNG docker container on 8899.
# Additive only: never touches the 8787/5180 logic above/below.
# Never kills anything; only starts Docker Desktop (if daemon down) or
# 'docker start xbloom-searxng' (if container stopped). Throttled to once
# per 60s so the 2s main loop stays fast.
# Task #99: every docker invocation is time-boxed (a half-booted Docker
# Desktop could otherwise hang the 2s main loop for tens of seconds and
# starve the 8787/5180 crash detection), and Docker Desktop launches
# converge: max 3 launches per round, 30-min cooldown after giving up,
# never launched when the container is known missing, and data\no-docker.flag
# disables Docker self-heal entirely.
$searxngPort       = 8899
$searxngContainer  = 'xbloom-searxng'
$lastSearxngCheck  = [DateTime]::MinValue
$dockerLaunchPath  = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

# --- task #99: Docker self-heal convergence state (script scope, survives loop iterations) ---
$noDockerFlagPath           = Join-Path $logDir 'no-docker.flag'  # present => skip Docker self-heal entirely
$script:noDockerFlagLogged  = $false
$script:dockerLaunchCount   = 0       # Docker Desktop launch attempts in the current round
$script:dockerLaunchGiveUpAt = $null  # when we gave up; a new round is allowed after cooldown
$dockerLaunchMax            = 3       # give up after this many launches with daemon still down
$dockerLaunchCooldownMin    = 30      # minutes to wait before trying another round
$script:searxngContainerMissing = $false  # container confirmed missing (daemon was up) => launching Docker Desktop is pointless

function Test-SearxngUp {
    try {
        return [bool](Get-NetTCPConnection -LocalPort $searxngPort -State Listen -ErrorAction SilentlyContinue)
    } catch { return $false }
}

# Task #99: time-boxed docker invocation. Docker Desktop half-booted can hang
# docker info/inspect/start for tens of seconds; WaitForExit(ms) + Kill caps it.
# Timeout is reported as TimedOut; the caller treats it as "skip this round"
# and never throws, so the watchdog loop keeps running.
function Invoke-Docker {
    param(
        [string[]]$DockerArgs,
        [int]$TimeoutMs = 2500
    )
    $result = @{ Ok = $false; Output = ''; TimedOut = $false }
    $p = $null
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'docker.exe'
        $psi.Arguments = ($DockerArgs -join ' ')
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        if (-not $p.WaitForExit($TimeoutMs)) {
            $result.TimedOut = $true
            try { $p.Kill() } catch { }
            return $result
        }
        $result.Output = ($p.StandardOutput.ReadToEnd()).Trim()
        $result.Ok = ($p.ExitCode -eq 0)
    } catch {
        $result.Ok = $false
    } finally {
        if ($p) { try { $p.Dispose() } catch { } }
    }
    return $result
}

function Ensure-Searxng {
    # Throttle: at most one probe per 60 seconds.
    if (((Get-Date) - $lastSearxngCheck).TotalSeconds -lt 60) { return }
    $script:lastSearxngCheck = Get-Date

    # Task #99: no-docker.flag -- user deliberately keeps Docker off; skip self-heal.
    if (Test-Path -LiteralPath $noDockerFlagPath) {
        if (-not $script:noDockerFlagLogged) {
            Write-Log "no-docker.flag present; Docker/SearXNG self-heal disabled."
            $script:noDockerFlagLogged = $true
        }
        return
    }

    if (Test-SearxngUp) { return }
    Write-Log ("SearXNG port " + $searxngPort + " down; probing docker...")
    # Is the docker CLI / daemon available? (2.5s time-box; timeout => skip this round)
    $info = Invoke-Docker -DockerArgs @('info','--format','{{.ServerVersion}}') -TimeoutMs 2500
    if ($info.TimedOut) { Write-Log "docker info timed out; skipping SearXNG heal this round."; return }
    if (-not $info.Ok) {
        # Daemon down. Task #99: if the container was already confirmed missing,
        # launching Docker Desktop cannot restore anything -- just log and stop.
        if ($script:searxngContainerMissing) {
            Write-Log ("Docker daemon down and container " + $searxngContainer + " confirmed missing earlier; NOT launching Docker Desktop (needs re-deploy).")
            return
        }
        # Task #99: convergence -- after $dockerLaunchMax launches with the daemon
        # still down, stop pestering the user (they may have deliberately stopped
        # Docker); allow one more round after the cooldown expires.
        if ($script:dockerLaunchGiveUpAt) {
            if (((Get-Date) - $script:dockerLaunchGiveUpAt).TotalMinutes -lt $dockerLaunchCooldownMin) { return }
            $script:dockerLaunchGiveUpAt = $null
            $script:dockerLaunchCount = 0
            Write-Log "Docker Desktop launch cooldown expired; allowing a new recovery round."
        }
        if ($script:dockerLaunchCount -ge $dockerLaunchMax) {
            $script:dockerLaunchGiveUpAt = Get-Date
            Write-Log ("Docker daemon still down after " + $dockerLaunchMax + " Docker Desktop launches; giving up for " + $dockerLaunchCooldownMin + " min (user may have intentionally stopped Docker).")
            return
        }
        # Daemon down: launch Docker Desktop (non-blocking; container has
        # restart=unless-stopped so it comes back once the daemon is up).
        if (Test-Path -LiteralPath $dockerLaunchPath) {
            $script:dockerLaunchCount = $script:dockerLaunchCount + 1
            Write-Log ("Docker daemon down; launching Docker Desktop (attempt " + $script:dockerLaunchCount + "/" + $dockerLaunchMax + ").")
            try { Start-Process -FilePath $dockerLaunchPath } catch { Write-Log ("Docker Desktop launch failed: " + $_) }
        } else {
            Write-Log "Docker Desktop not found at expected path; cannot restore SearXNG."
        }
        return
    }
    # Daemon up but port down: start our container if it exists and is stopped. (1.5s time-box)
    $state = Invoke-Docker -DockerArgs @('inspect','-f','{{.State.Status}}',$searxngContainer) -TimeoutMs 1500
    if ($state.TimedOut) { Write-Log "docker inspect timed out; skipping SearXNG heal this round."; return }
    if (-not $state.Ok) {
        # Task #99: remember the container is missing so future rounds never launch
        # Docker Desktop for it (launching cannot bring back a missing container).
        if (-not $script:searxngContainerMissing) {
            $script:searxngContainerMissing = $true
            Write-Log ("Container " + $searxngContainer + " not found; SearXNG not restored (needs re-deploy). Docker Desktop auto-launch disabled until the container exists.")
        }
        return
    }
    $st = $state.Output
    if ($st -ne 'running') {
        Write-Log ("Starting container " + $searxngContainer + " (state=" + $st + ").")
        $start = Invoke-Docker -DockerArgs @('start',$searxngContainer) -TimeoutMs 1500
        if ($start.TimedOut) { Write-Log "docker start timed out; will retry next round." }
    } else {
        Write-Log ("Container " + $searxngContainer + " reports running but port " + $searxngPort + " down; leaving to docker health/restart policy.")
    }
}

# --- XHS MCP self-heal (task #82): local xiaohongshu-mcp service on 18060.
# Additive only: never touches any logic above/below; it only runs
# tools\xhs-mcp\start-xhs-mcp.ps1 (which is ownership-aware and idempotent and
# skips when 18060 already listens). Throttled to once per 300s (the
# launcher itself may wait up to ~4 min for readiness on first run).
$xhsMcpPort      = 18060
$lastXhsMcpCheck = [DateTime]::MinValue
$xhsMcpScript    = Join-Path $ROOT 'tools\xhs-mcp\start-xhs-mcp.ps1'

function Test-XhsMcpUp {
    try {
        return [bool](Get-NetTCPConnection -LocalPort $xhsMcpPort -State Listen -ErrorAction SilentlyContinue)
    } catch { return $false }
}

function Ensure-XhsMcp {
    # Throttle: at most one probe per 300 seconds.
    if (((Get-Date) - $lastXhsMcpCheck).TotalSeconds -lt 300) { return }
    $script:lastXhsMcpCheck = Get-Date
    if (Test-XhsMcpUp) { return }
    if (-not (Test-Path -LiteralPath $xhsMcpScript)) {
        Write-Log "XHS MCP launcher not found; cannot restore xiaohongshu-mcp."
        return
    }
    Write-Log ("XHS MCP port " + $xhsMcpPort + " down; running start-xhs-mcp.ps1 (hidden, may take minutes on first run).")
    # Non-blocking launch; the launcher waits for readiness itself and logs to tools\xhs-mcp.
    try {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$xhsMcpScript `
            -WindowStyle Hidden
    } catch { Write-Log ("XHS MCP launch failed: " + $_) }
}

# --- single-instance guard (named mutex) ---
# Scope the mutex to this checkout, so a second installed copy never controls or
# reopens another copy. The port ownership checks below remain the final guard.
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $rootBytes = [Text.Encoding]::UTF8.GetBytes($ROOT.ToLowerInvariant())
    $rootHash = ([BitConverter]::ToString($sha256.ComputeHash($rootBytes))).Replace('-', '').Substring(0, 16)
} finally {
    $sha256.Dispose()
}
$mutex = New-Object System.Threading.Mutex($false, ('Local\xBloom-Watchdog-' + $rootHash))
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch { $owned = $true }  # abandoned mutex => we take it
if (-not $owned) {
    # Already running (user double-clicked the shortcut again): just re-open/refocus
    # the browser to the frontend so they see the app, then exit. Idempotent.
    Write-Log "Another watchdog instance is already running. Re-opening browser and exit."
    try { Start-Process -FilePath ("http://localhost:" + $webPort) } catch { }
    try { $mutex.Dispose() } catch { }
    exit 0
}

function Test-Port {
    param([int]$Port)
    # Simple port-listening check (no ownership verification).
    try {
        return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    } catch { return $false }
}

function Test-ServiceCommandLine {
    param([string]$CommandLine, [string]$Name)
    if (-not $CommandLine -or $CommandLine.IndexOf($ROOT, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $false
    }
    if ($Name -eq 'Backend') {
        return ($CommandLine -match '(?i)npm(?:\.cmd)?\s+run\s+dev') -or
            (($CommandLine -match '(?i)tsx') -and ($CommandLine -match '(?i)src[\\/]index\.ts'))
    }
    if ($Name -eq 'Frontend') {
        return ($CommandLine -match '(?i)npx(?:\.cmd)?\s+vite') -or
            (($CommandLine -match '(?i)(?:^|[\\/\s])vite(?:\.js)?(?:[\s"'']|$)') -and
                ($CommandLine -match ('(?i)--port\s+' + [regex]::Escape([string]$webPort))))
    }
    return $false
}

function Test-TrackedServiceProcess {
    param([int]$ProcessId, [string]$Name)
    if (-not $ProcessId) { return $false }
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
        return [bool]($proc -and (Test-ServiceCommandLine -CommandLine $proc.CommandLine -Name $Name))
    } catch { return $false }
}

function Test-PortOwned {
    param([int]$Port, [string]$Name)
    # Returns $true only if the port is listening AND the owning process's
    # CommandLine contains $ROOT (the project path). This prevents false
    # positives when another app (e.g. Open Science) occupies the same port.
    # NEVER kills the non-xBloom process -- just returns $false so the caller
    # can start its own service on a different port or wait.
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        if ($conns.Count -eq 0) { return $false }
        foreach ($c in $conns) {
            $opid = $c.OwningProcess
            if (-not $opid) { continue }
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$opid" -ErrorAction SilentlyContinue
            if ($proc -and (Test-ServiceCommandLine -CommandLine $proc.CommandLine -Name $Name)) {
                return $true
            }
        }
        return $false
    } catch { return $false }
}

function Start-HiddenService {
    param(
        [string]$WorkDir,
        [string[]]$Cmd,
        [string]$LogFile
    )
    # cmd /c <cmd> 1>"<log>" 2>&1  -- redirect stdout+stderr to a per-launch log.
    # ROOT has no spaces, so no quoting headaches for cmd.
    $argLine = '/c ' + ($Cmd -join ' ') + ' 1>"' + $LogFile + '" 2>&1'
    try { if (Test-Path -LiteralPath $LogFile) { Clear-Content -LiteralPath $LogFile -ErrorAction SilentlyContinue } } catch { }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = $argLine
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $p = [System.Diagnostics.Process]::Start($psi)
    return $p.Id
}

function Start-ServiceIfPortFree {
    param([hashtable]$Service, [string]$Action)
    if (Test-Port -Port $Service.Port) {
        $Service.ConflictLoggedAt = Get-Date
        Write-Log ($Service.Name + " port " + $Service.Port + " is occupied by another process; waiting without launching a competing service.")
        return $false
    }
    $Service.Pid = Start-HiddenService -WorkDir $Service.Dir -Cmd $Service.Cmd -LogFile $Service.Log
    Write-Log ($Service.Name + " " + $Action + ", pid=" + $Service.Pid)
    return $true
}

$serverDir  = Join-Path $ROOT 'server'
$webDir     = Join-Path $ROOT 'web'

# Both TypeScript apps import the same built contract package. Rebuild it once
# before launch so a source update never leaves server/web using stale schemas.
$sharedBuildLog = Join-Path $logDir 'xbloom-shared-build.log'
$sharedBuildErrorLog = Join-Path $logDir 'xbloom-shared-build-error.log'
$sharedBuild = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'npm run build --workspace shared') `
    -WorkingDirectory $ROOT `
    -WindowStyle Hidden `
    -RedirectStandardOutput $sharedBuildLog `
    -RedirectStandardError $sharedBuildErrorLog `
    -Wait -PassThru
if ($sharedBuild.ExitCode -ne 0) {
    Write-Log ("Shared contract build failed with exit code " + $sharedBuild.ExitCode + "; see " + $sharedBuildLog)
    throw "Shared contract build failed."
}
Write-Log 'Shared contract package rebuilt before service launch.'

$services = @(
    @{ Name='Backend';  Dir=$serverDir; Cmd=@('npm','run','dev');                            Port=$serverPort; Log=$backendLog;  Pid=$null; DownSince=$null; ConflictLoggedAt=$null; CrashCount=0; LastCrash=$null }
    @{ Name='Frontend'; Dir=$webDir;    Cmd=@('npx','vite','--port',([string]$webPort),'--strictPort'); Port=$webPort; Log=$frontendLog; Pid=$null; DownSince=$null; ConflictLoggedAt=$null; CrashCount=0; LastCrash=$null }
)

Write-Log ("=== watchdog started; ROOT=" + $ROOT + " ===")

# --- initial launch (skip only if OUR process is already listening) ---
foreach ($s in $services) {
    if (Test-PortOwned -Port $s.Port -Name $s.Name) {
        Write-Log ($s.Name + " already listening on " + $s.Port + " (owned by us); monitor only.")
    } elseif (Test-Port -Port $s.Port) {
        $s.ConflictLoggedAt = Get-Date
        Write-Log ($s.Name + " port " + $s.Port + " is occupied by another process; waiting for the configured port.")
    } else {
        Write-Log ("Starting " + $s.Name + " (port " + $s.Port + ") hidden...")
        [void](Start-ServiceIfPortFree -Service $s -Action 'started')
    }
}

# --- wait for frontend ready (owned by us), then open browser once (up to 60s) ---
$browserOpened = $false
$waitStart = Get-Date
while (-not $browserOpened) {
    if (Test-PortOwned -Port $webPort -Name 'Frontend') {
        Write-Log ("Frontend ready on " + $webPort + " (owned by us). Opening browser to http://localhost:" + $webPort)
        try { Start-Process -FilePath ("http://localhost:" + $webPort) } catch { Write-Log ("Browser open failed: " + $_) }
        $browserOpened = $true
    } else {
        if (((Get-Date) - $waitStart).TotalSeconds -ge 60) {
            Write-Log "Frontend not ready within 60s; continuing watchdog (no browser open)."
            $browserOpened = $true
        }
        Start-Sleep -Seconds 1
    }
}

# --- main monitoring loop ---
$interval     = 2
$graceSeconds  = 15  # tolerate slow cold-start / tsx-watch internal restart (process ALIVE but port down) before force-restart
while ($true) {
    # SearXNG (8899) self-heal check -- additive, throttled, non-blocking.
    try { Ensure-Searxng } catch { }
    # XHS MCP (18060) self-heal check (task #82) -- additive, throttled, non-blocking.
    try { Ensure-XhsMcp } catch { }
    foreach ($s in $services) {
        try { $portUp = Test-PortOwned -Port $s.Port -Name $s.Name } catch { $portUp = $false }

        if ($portUp) {
            $s.DownSince = $null
            $s.ConflictLoggedAt = $null
            # drop tracking if the process we started died but our orphan still serves the port
            if ($s.Pid -and -not (Test-TrackedServiceProcess -ProcessId $s.Pid -Name $s.Name)) {
                $s.Pid = $null
            }
            continue
        }

        # A foreign listener owns the configured port. Keep it untouched and
        # wait until the user frees or changes the port; never launch a doomed
        # competing process behind it.
        if (Test-Port -Port $s.Port) {
            $s.DownSince = $null
            if ($s.Pid -and -not (Test-TrackedServiceProcess -ProcessId $s.Pid -Name $s.Name)) {
                $s.Pid = $null
            }
            if (-not $s.ConflictLoggedAt -or ((Get-Date) - $s.ConflictLoggedAt).TotalSeconds -ge 60) {
                $s.ConflictLoggedAt = Get-Date
                Write-Log ($s.Name + " port " + $s.Port + " remains occupied by another process; waiting.")
            }
            continue
        }
        $s.ConflictLoggedAt = $null

        # ---- port DOWN ----
        $alive = [bool]($s.Pid -and (Test-TrackedServiceProcess -ProcessId $s.Pid -Name $s.Name))

        if ($s.Pid -and -not $alive) {
            # tracked process DEAD + port not owned by us => real crash; relaunch with cooldown
            $now = Get-Date
            if ($s.LastCrash -and (($now - $s.LastCrash).TotalSeconds -lt 10)) {
                $s.CrashCount = [int]$s.CrashCount + 1
            } else {
                $s.CrashCount = 1
            }
            $s.LastCrash = $now
            $delay = [Math]::Min($s.CrashCount * 3, 30)
            Write-Log ($s.Name + " pid " + $s.Pid + " exited (port " + $s.Port + " down); crash #" + $s.CrashCount + ", restart in " + $delay + "s.")
            Start-Sleep -Seconds $delay
            $s.Pid = $null
            $s.DownSince = $null
            [void](Start-ServiceIfPortFree -Service $s -Action 'restarted')
            continue
        }

        if ($s.Pid -and $alive) {
            # process ALIVE but port down => cold-start in progress, tsx-watch internal restart, or stuck
            if (-not $s.DownSince) {
                $s.DownSince = Get-Date
                Write-Log ($s.Name + " port " + $s.Port + " down (pid " + $s.Pid + " alive); waiting up to " + $graceSeconds + "s.")
            }
            if (((Get-Date) - $s.DownSince).TotalSeconds -ge $graceSeconds) {
                if (Test-TrackedServiceProcess -ProcessId $s.Pid -Name $s.Name) {
                    Write-Log ($s.Name + " still down > " + $graceSeconds + "s; stopping verified stuck pid " + $s.Pid + " and restarting.")
                    & taskkill.exe /PID $s.Pid /T /F 2>$null | Out-Null
                } else {
                    Write-Log ($s.Name + " tracked pid " + $s.Pid + " no longer matches this checkout; leaving it untouched.")
                }
                Start-Sleep -Seconds 1
                $s.Pid = $null
                $s.DownSince = $null
                [void](Start-ServiceIfPortFree -Service $s -Action 'restarted')
            }
            continue
        }

        # untracked + no listener => grace then relaunch
        if (-not $s.DownSince) {
            $s.DownSince = Get-Date
            Write-Log ($s.Name + " port " + $s.Port + " down (untracked); grace " + $graceSeconds + "s before restart.")
        }
        if (((Get-Date) - $s.DownSince).TotalSeconds -ge $graceSeconds) {
            Write-Log ($s.Name + " still down after " + $graceSeconds + "s; starting hidden service.")
            $s.DownSince = $null
            [void](Start-ServiceIfPortFree -Service $s -Action 'started')
        }
    }
    Start-Sleep -Seconds $interval
}
