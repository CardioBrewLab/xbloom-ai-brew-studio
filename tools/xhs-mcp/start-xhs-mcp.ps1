#requires -Version 5.1
# Starts the pinned Windows-fixed xiaohongshu-mcp binary in the background.
$ErrorActionPreference = "Stop"
$Directory = [IO.Path]::GetFullPath($PSScriptRoot)
$Executable = Join-Path $Directory "xiaohongshu-mcp.exe"
$Release = Import-PowerShellDataFile -LiteralPath (Join-Path $Directory 'xhs-mcp-release.psd1')
$ExpectedSha256 = ([string]$Release.Sha256).ToUpperInvariant()
$RuntimeDirectory = Join-Path $Directory 'runtime'
$CookiesFile = Join-Path $RuntimeDirectory "cookies.json"
$LogOut = Join-Path $RuntimeDirectory "xhs-mcp.out.log"
$LogErr = Join-Path $RuntimeDirectory "xhs-mcp.err.log"
$Port = 18060

if ($ExpectedSha256 -notmatch '^[0-9A-F]{64}$') {
    throw 'Xiaohongshu MCP release manifest is invalid.'
}

function Assert-NotReparsePoint([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Xiaohongshu MCP private path contains a reparse point: $Path"
    }
}

function Protect-PrivateRuntimeDirectory([string]$Path) {
    Assert-NotReparsePoint $Directory
    Assert-NotReparsePoint $Path
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Assert-NotReparsePoint $Path
    foreach ($privateFile in @($CookiesFile, $LogOut, $LogErr)) {
        Assert-NotReparsePoint $privateFile
    }
    $directoryInfo = Get-Item -LiteralPath $Path -Force
    # Request and write the DACL only. Reusing Set-Acl's broader descriptor on
    # an already-protected directory can ask for SeSecurityPrivilege on a
    # standard user account during the second idempotent launch.
    $acl = $directoryInfo.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        $acl.RemoveAccessRuleAll($existingRule)
    }
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $identities = @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        (New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)),
        (New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null))
    )
    foreach ($identity in $identities) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            $fullControl,
            $inheritance,
            $propagation,
            $allow
        )
        $acl.AddAccessRule($rule)
    }
    $directoryInfo.SetAccessControl($acl)
}

function Test-OwnedExecutablePath($Process) {
    if (-not $Process -or -not $Process.ExecutablePath) { return $false }
    try {
        return [String]::Equals(
            [IO.Path]::GetFullPath($Process.ExecutablePath),
            $Executable,
            [StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Test-VerifiedExecutable {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $actual = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash.ToUpperInvariant()
        return $actual -eq $ExpectedSha256
    } catch {
        return $false
    }
}

Protect-PrivateRuntimeDirectory $RuntimeDirectory
Assert-NotReparsePoint $Executable

if (-not (Test-VerifiedExecutable)) {
    $runningFromPath = @(Get-CimInstance Win32_Process -Filter "Name='xiaohongshu-mcp.exe'" -ErrorAction SilentlyContinue |
        Where-Object { Test-OwnedExecutablePath $_ })
    if ($runningFromPath) {
        throw 'The project Xiaohongshu MCP executable changed while its process is running. Run stop-xbloom.bat, then start again.'
    }
    & (Join-Path $Directory "install-xhs-mcp.ps1")
}
if (-not (Test-VerifiedExecutable)) {
    throw 'Xiaohongshu MCP executable verification failed after installation.'
}

$listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listener) {
    $foreignPids = New-Object System.Collections.Generic.List[int]
    foreach ($listenerPid in @($listener | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
        if (-not (Test-OwnedExecutablePath $listenerProcess)) {
            $foreignPids.Add([int]$listenerPid)
        }
    }
    if ($foreignPids.Count -gt 0) {
        throw "Port $Port is already used by another process (PID $($foreignPids -join ',')). Set XHS_MCP_URL to a separately managed service or free this port."
    }
    Write-Host "The project-owned Xiaohongshu MCP is already listening on $Port; verifying health."
}

$ownedProcess = @(Get-CimInstance Win32_Process -Filter "Name='xiaohongshu-mcp.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-OwnedExecutablePath $_ })
if ($ownedProcess -and -not $listener) {
    Write-Host "Xiaohongshu MCP is starting (PID $($ownedProcess.ProcessId -join ',')); waiting up to 30 seconds."
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        Start-Sleep -Seconds 2
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                Write-Host "Xiaohongshu MCP ready: http://127.0.0.1:$Port"
                exit 0
            }
        } catch { }
    }
    $ownedProcess = @(Get-CimInstance Win32_Process -Filter "Name='xiaohongshu-mcp.exe'" -ErrorAction SilentlyContinue |
        Where-Object { Test-OwnedExecutablePath $_ })
    foreach ($process in $ownedProcess) {
        Write-Host "Restarting stalled project-owned Xiaohongshu MCP (PID $($process.ProcessId))."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    $ownedProcess = @()
}

if (-not $ownedProcess) {
    $listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listener) {
        throw "Port $Port became occupied before Xiaohongshu MCP could start."
    }
    # Each user's session stays in a private, project-local, Git-ignored runtime
    # directory. The cookie-import fallback writes to this same absolute path.
    $env:COOKIES_PATH = $CookiesFile
    $headless = if ($env:XHS_HEADLESS -and $env:XHS_HEADLESS.Trim().ToLowerInvariant() -eq "false") { "false" } else { "true" }
    Start-Process -FilePath $Executable `
        -ArgumentList "-port", ":$Port", "-headless=$headless" `
        -WorkingDirectory $RuntimeDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogOut `
        -RedirectStandardError $LogErr
}

# First launch may download the upstream browser runtime (about 150 MB).
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) {
            Write-Host "Xiaohongshu MCP ready: http://127.0.0.1:$Port"
            exit 0
        }
    } catch { }
}

throw "Xiaohongshu MCP did not become ready. Read $LogOut and $LogErr."
