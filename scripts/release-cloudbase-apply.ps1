param(
    [string]$EnvId
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "database-common.ps1")

Assert-Tcb

if (-not $EnvId) {
    $EnvId = Get-RenianEnvId
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $repoRoot "cloudbaserc.release.json"

if (-not (Test-Path -LiteralPath $configFile)) {
    throw "Missing cloudbaserc.release.json. Pull the latest main branch first."
}

Write-Host ""
Write-Host "===================================================="
Write-Host " RENIAN RELEASE CLOUDBASE APPLY"
Write-Host "===================================================="
Write-Host ("Environment: " + $EnvId)
Write-Host ""

function Deploy-RenianFunction {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    Write-Host ""
    Write-Host ("---------------- DEPLOY: " + $Name + " ----------------")
    Invoke-Tcb -TcbArgs @(
        "fn", "deploy", $Name,
        "--dir", $Directory,
        "--env-id", $EnvId,
        "--install-dependency", "true",
        "--force",
        "--yes"
    )
}

Deploy-RenianFunction -Name "renianApi" -Directory (Join-Path $repoRoot "cloudfunctions\renianApi")
Deploy-RenianFunction -Name "dailyReminder" -Directory (Join-Path $repoRoot "cloudfunctions\dailyReminder")
Deploy-RenianFunction -Name "mediaCleanup" -Directory (Join-Path $repoRoot "cloudfunctions\mediaCleanup")

Write-Host ""
Write-Host "---------------- APPLY FUNCTION SETTINGS ----------------"

Invoke-Tcb -TcbArgs @(
    "config", "update", "fn", "renianApi",
    "--timeout", "60",
    "--memory", "512",
    "--env-id", $EnvId,
    "--yes"
)

Invoke-Tcb -TcbArgs @(
    "config", "update", "fn", "dailyReminder",
    "--timeout", "60",
    "--memory", "256",
    "--env-id", $EnvId,
    "--yes"
)

Invoke-Tcb -TcbArgs @(
    "config", "update", "fn", "mediaCleanup",
    "--timeout", "60",
    "--memory", "256",
    "--env-id", $EnvId,
    "--yes"
)

Write-Host ""
Write-Host "---------------- CREATE TIMER TRIGGERS ----------------"

Invoke-Tcb -TcbArgs @(
    "fn", "trigger", "create", "dailyReminder",
    "--env-id", $EnvId,
    "--config-file", $configFile,
    "--yes"
)

Invoke-Tcb -TcbArgs @(
    "fn", "trigger", "create", "mediaCleanup",
    "--env-id", $EnvId,
    "--config-file", $configFile,
    "--yes"
)

Write-Host ""
Write-Host "===================================================="
Write-Host " APPLY COMPLETE - RUNNING READ-ONLY AUDIT"
Write-Host "===================================================="
Write-Host ""

& (Join-Path $PSScriptRoot "release-cloudbase-audit.ps1") -EnvId $EnvId
if ($LASTEXITCODE -ne 0) {
    throw "Post-deploy CloudBase audit failed with exit code $LASTEXITCODE"
}
