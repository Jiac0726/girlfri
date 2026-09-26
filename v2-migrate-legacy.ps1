param(
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

. (Join-Path $PSScriptRoot "scripts/database-common.ps1")

function Invoke-LegacyMigrationFunction {
    param(
        [Parameter(Mandatory = $true)][string]$EnvId,
        [Parameter(Mandatory = $true)][hashtable]$Payload
    )

    $paramsJson = ConvertTo-Json -InputObject $Payload -Depth 8 -Compress
    return Invoke-TcbExactArgs -Capture -TcbArgs @(
        "fn", "invoke", "legacyV2Migration",
        "--params", $paramsJson,
        "--env-id", $EnvId
    )
}

Write-Host ""
Write-Host "===================================================="
Write-Host " Renian - LEGACY -> V2 DATA INHERITANCE"
Write-Host "===================================================="
Write-Host ""
Write-Host "This migration keeps the old collections untouched."
Write-Host "It copies binding relationships, users, moods, reminders,"
Write-Host "ratings, permissions and privilege cards into v2 collections."
Write-Host ""

try {
    Assert-Tcb
    $envId = Get-RenianEnvId

    Write-Host "[1/4] Creating a fresh read-only legacy backup..." -ForegroundColor Cyan
    $preflight = New-RenianPreflight
    if (-not $preflight.safeToMigrate) {
        Write-Host ""
        Write-Host "[STOP] Legacy preflight has blockers. Nothing was written to v2." -ForegroundColor Red
        Write-Host ("Open: " + (Join-Path $preflight.backupDir "PRECHECK.txt"))
        exit 40
    }

    Write-Host ""
    Write-Host "[2/4] Asking legacyV2Migration for a migration plan..." -ForegroundColor Cyan
    $plan = Invoke-LegacyMigrationFunction -EnvId $envId -Payload @{ mode = "plan" }
    Write-Host $plan
    Write-Host ""

    if (-not $Yes) {
        Write-Host "Before continuing, confirm that:"
        Write-Host "  - all v2_ collections from config/database.v2.json exist;"
        Write-Host "  - v2 is not yet live for real users;"
        Write-Host "  - legacyV2Migration has been deployed with cloud dependencies."
        Write-Host ""
        $answer = Read-Host "Type MIGRATE_V2 to copy legacy data into v2"
        if ($answer -ne "MIGRATE_V2") {
            Write-Host "[CANCELLED] Nothing was changed."
            exit 41
        }
    }

    Write-Host ""
    Write-Host "[3/4] Applying migration..." -ForegroundColor Cyan
    $apply = Invoke-LegacyMigrationFunction -EnvId $envId -Payload @{
        mode = "apply"
        confirm = "MIGRATE_V2_FROM_LEGACY"
    }
    Write-Host $apply

    Write-Host ""
    Write-Host "[4/4] Reading final migration state..." -ForegroundColor Cyan
    $final = Invoke-LegacyMigrationFunction -EnvId $envId -Payload @{ mode = "plan" }
    Write-Host $final

    Write-Host ""
    Write-Host "===================================================="
    Write-Host " MIGRATION COMMAND FINISHED" -ForegroundColor Green
    Write-Host "===================================================="
    Write-Host ("Legacy backup: " + $preflight.backupDir)
    Write-Host ""
    Write-Host "Check the final response for marker.status = completed before switching v2 live."
    Write-Host "After verification, delete the temporary legacyV2Migration cloud function."
    exit 0
} catch {
    Write-Host ""
    Write-Host ("[ERROR] " + $_.Exception.Message) -ForegroundColor Red
    Write-Host ""
    Write-Host "No legacy collection is deleted by this script."
    Write-Host "If migration stopped part-way, fix the cause and run this script again;"
    Write-Host "the migration function uses deterministic document IDs and resumes a running migration."
    exit 1
}
