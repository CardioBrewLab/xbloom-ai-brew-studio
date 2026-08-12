#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^$|^https://')][string]$LlmBaseUrl = '',
    [ValidateLength(0,200)][string]$LlmModel = '',
    [string]$WorkerName = 'xbloom-ai-brew-studio',
    [ValidateSet('free','scale')][string]$XhsBrowserProfile = 'free',
    [switch]$SkipDeploy,
    [switch]$ConfigureSharedGuestModel,
    [switch]$RotateEdgeProxySecret
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Config = Join-Path $PSScriptRoot 'wrangler.generated.jsonc'
$Template = Join-Path $PSScriptRoot 'wrangler.template.jsonc'
$DatabaseName = ($WorkerName + '-db')
$EdgeSecretFile = Join-Path $PSScriptRoot '.wrangler\edge-proxy-secret.txt'

if ([bool]$LlmBaseUrl -xor [bool]$LlmModel) {
    throw 'LlmBaseUrl and LlmModel must be provided together.'
}
if ($ConfigureSharedGuestModel -and (-not $LlmBaseUrl -or -not $LlmModel)) {
    throw 'ConfigureSharedGuestModel requires LlmBaseUrl and LlmModel.'
}

function Invoke-Npx([string[]]$Arguments) {
    & npx @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npx $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function New-RandomHex([int]$Bytes = 32) {
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
}

function Set-WorkerSecret([string]$Name, [string]$Value) {
    $Value | npx wrangler secret put $Name --config $Config
    if ($LASTEXITCODE -ne 0) { throw "Saving $Name failed" }
}

function Set-XhsBrowserProfile([string]$ConfigText) {
    $profileValues = if ($XhsBrowserProfile -eq 'scale') {
        @{
            Profile = 'scale'; Qr = '2500'; Search = '20000'; OwnerQr = '8'; OwnerSearch = '100'
        }
    } else {
        @{
            Profile = 'free'; Qr = '3'; Search = '20'; OwnerQr = '3'; OwnerSearch = '10'
        }
    }
    return $ConfigText.Replace('"XHS_BROWSER_PROFILE": "free"', '"XHS_BROWSER_PROFILE": "' + $profileValues.Profile + '"').Replace('"XHS_BROWSER_QR_DAILY_LIMIT": "3"', '"XHS_BROWSER_QR_DAILY_LIMIT": "' + $profileValues.Qr + '"').Replace('"XHS_BROWSER_SEARCH_DAILY_LIMIT": "20"', '"XHS_BROWSER_SEARCH_DAILY_LIMIT": "' + $profileValues.Search + '"').Replace('"XHS_BROWSER_QR_OWNER_DAILY_LIMIT": "3"', '"XHS_BROWSER_QR_OWNER_DAILY_LIMIT": "' + $profileValues.OwnerQr + '"').Replace('"XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT": "10"', '"XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT": "' + $profileValues.OwnerSearch + '"')
}

Push-Location $Root
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
} finally { Pop-Location }

Push-Location $PSScriptRoot
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Cloudflare npm ci failed' }

    # Preflight only: compile without creating remote resources or secrets.
    if ($SkipDeploy) {
        $configText = (Get-Content -Raw -LiteralPath $Template -Encoding utf8)
        $configText = $configText.Replace('xbloom-ai-brew-studio', $WorkerName).Replace('https://YOUR_OPENAI_COMPATIBLE_HOST/v1', $LlmBaseUrl.TrimEnd('/')).Replace('YOUR_MODEL_ID', $LlmModel)
        $configText = Set-XhsBrowserProfile $configText
        [IO.File]::WriteAllText($Config, $configText, [Text.UTF8Encoding]::new($false))
        Invoke-Npx @('wrangler','deploy','--dry-run','--config',$Config)
        Write-Host 'Cloudflare preflight passed; no remote resources were changed.' -ForegroundColor Green
        return
    }

    # Query first so repeated deployments stay idempotent. In Windows PowerShell 5,
    # Wrangler's expected "already exists" stderr is promoted to a terminating
    # ErrorRecord when ErrorActionPreference is Stop.
    $listOutput = (& npx wrangler d1 list --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw $listOutput }
    $dbs = @($listOutput | ConvertFrom-Json)
    $databaseId = ($dbs | Where-Object { $_.name -eq $DatabaseName } | Select-Object -First 1).uuid
    if (-not $databaseId) {
        $createOutput = (& npx wrangler d1 create $DatabaseName 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw $createOutput }
        $databaseId = [regex]::Match($createOutput, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'IgnoreCase').Value
    }
    if (-not $databaseId) { throw "D1 database id was not found for $DatabaseName" }

    $configText = (Get-Content -Raw -LiteralPath $Template -Encoding utf8)
    $configText = $configText.Replace('xbloom-ai-brew-studio', $WorkerName).Replace('00000000-0000-0000-0000-000000000000', $databaseId).Replace('https://YOUR_OPENAI_COMPATIBLE_HOST/v1', $LlmBaseUrl.TrimEnd('/')).Replace('YOUR_MODEL_ID', $LlmModel)
    $configText = Set-XhsBrowserProfile $configText
    [IO.File]::WriteAllText($Config, $configText, [Text.UTF8Encoding]::new($false))

    Invoke-Npx @('wrangler','d1','migrations','apply',$DatabaseName,'--remote','--config',$Config)
    $secretListOutput = (& npx wrangler secret list --config $Config --format json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw $secretListOutput }
    $secretList = @($secretListOutput | ConvertFrom-Json)
    $hasSessionSecret = [bool]($secretList | Where-Object { $_.name -eq 'APP_SESSION_SECRET' } | Select-Object -First 1)
    if (-not $hasSessionSecret) {
        Set-WorkerSecret 'APP_SESSION_SECRET' (New-RandomHex)
    } else {
        Write-Host 'Existing APP_SESSION_SECRET preserved; browser-owned D1 records remain linked.'
    }
    $hasPasswordPepper = [bool]($secretList | Where-Object { $_.name -eq 'APP_PASSWORD_PEPPER' } | Select-Object -First 1)
    if (-not $hasPasswordPepper) {
        Set-WorkerSecret 'APP_PASSWORD_PEPPER' (New-RandomHex)
    } else {
        Write-Host 'Existing APP_PASSWORD_PEPPER preserved; account password verifiers remain valid.'
    }
    $hasDataSecret = [bool]($secretList | Where-Object { $_.name -eq 'APP_DATA_ENCRYPTION_KEY' } | Select-Object -First 1)
    if (-not $hasDataSecret) {
        Set-WorkerSecret 'APP_DATA_ENCRYPTION_KEY' (New-RandomHex)
    } else {
        Write-Host 'Existing APP_DATA_ENCRYPTION_KEY preserved; user settings remain decryptable.'
    }

    $hasEdgeSecret = [bool]($secretList | Where-Object { $_.name -eq 'EDGE_PROXY_SECRET' } | Select-Object -First 1)
    if ($RotateEdgeProxySecret -or -not $hasEdgeSecret) {
        $edgeSecret = New-RandomHex
        Set-WorkerSecret 'EDGE_PROXY_SECRET' $edgeSecret
        New-Item -ItemType Directory -Force -Path (Split-Path $EdgeSecretFile -Parent) | Out-Null
        [IO.File]::WriteAllText($EdgeSecretFile, $edgeSecret, [Text.UTF8Encoding]::new($false))
        Write-Host "EdgeOne proxy secret saved locally at $EdgeSecretFile (git-ignored)."
    } elseif (Test-Path -LiteralPath $EdgeSecretFile) {
        Write-Host 'Existing EDGE_PROXY_SECRET preserved; local EdgeOne copy is available.'
    } else {
        Write-Warning 'EDGE_PROXY_SECRET exists remotely but the local copy is absent. Use -RotateEdgeProxySecret before configuring a new EdgeOne project.'
    }

    if ($ConfigureSharedGuestModel) {
        $secureKey = Read-Host 'Shared guest LLM API Key (optional deployment-wide fallback)' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
            Set-WorkerSecret 'LLM_API_KEY' $plainKey
        } finally {
            $plainKey = $null
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
    Invoke-Npx @('wrangler','deploy','--dry-run','--config',$Config)
    Invoke-Npx @('wrangler','deploy','--config',$Config)
} finally { Pop-Location }

Write-Host 'Cloudflare hosted edition is ready.' -ForegroundColor Green
