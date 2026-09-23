$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

. (Join-Path $PSScriptRoot "scripts/database-common.ps1")

Write-Host ""
Write-Host "===================================================="
Write-Host " Renian - CloudBase PRE-FLIGHT (READ ONLY)"
Write-Host "===================================================="
Write-Host ""
Write-Host "This step only exports and audits data. It does NOT modify the database."
Write-Host ""

try {
    $report = New-RenianPreflight

    Write-Host ""
    Write-Host "===================================================="
    if ($report.safeToMigrate) {
        Write-Host " PRE-FLIGHT PASSED" -ForegroundColor Green
    } else {
        Write-Host " PRE-FLIGHT BLOCKED" -ForegroundColor Red
    }
    Write-Host "===================================================="
    Write-Host ("Backup: " + $report.backupDir)
    Write-Host ("Blockers: " + $report.blockingIssueCount)
    Write-Host ("Warnings: " + $report.warningCount)
    Write-Host ("Non-waiting inviteCodes to normalize: " + @($report.couples.normalizationCandidates).Count)
    Write-Host ""
    Write-Host ("Open: " + (Join-Path $report.backupDir "PRECHECK.txt"))

    if (-not $report.safeToMigrate) {
        exit 30
    }

    exit 0
} catch {
    Write-Host ""
    Write-Host ("[ERROR] " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
