param(
    [switch]$SkipIndexes
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$Message, [int]$Code = 1) {
    Write-Host ""
    Write-Host ("[ERROR] " + $Message) -ForegroundColor Red
    exit $Code
}

function Run-Tcb([string[]]$Args) {
    & tcb @Args
    if ($LASTEXITCODE -ne 0) {
        throw "tcb $($Args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Run-NoSql([string]$EnvId, [string]$CommandJson) {
    Run-Tcb @(
        "db", "nosql", "execute",
        "--command", $CommandJson,
        "--env-id", $EnvId,
        "--json"
    )
}

Write-Host ""
Write-Host "===================================================="
Write-Host " Renian - Backup current DB and build new indexes"
Write-Host "===================================================="
Write-Host ""

if (-not (Get-Command tcb -ErrorAction SilentlyContinue)) {
    Write-Host "[MISSING] CloudBase CLI was not found." -ForegroundColor Yellow
    Write-Host "Install it once with:"
    Write-Host "  npm i -g @cloudbase/cli"
    Write-Host "Then run:"
    Write-Host "  tcb login"
    exit 20
}

$envFile = Join-Path $PSScriptRoot "config/env.local.js"
if (-not (Test-Path $envFile)) {
    Fail "config/env.local.js is missing. Run setup-local.cmd first." 21
}

$envText = Get-Content $envFile -Raw
$envMatch = [regex]::Match($envText, "cloudEnv\s*:\s*['""]([^'""]+)['""]")
if (-not $envMatch.Success) {
    Fail "Could not read cloudEnv from config/env.local.js." 22
}

$envId = $envMatch.Groups[1].Value.Trim()
if (-not $envId -or $envId -eq "YOUR_ENV_ID") {
    Fail "Cloud environment ID is not configured." 23
}

Write-Host ("Environment: " + $envId)
Write-Host ""

Write-Host "[1/6] Verifying CloudBase login and environment access..."
Run-Tcb @("env", "info", "--env-id", $envId, "--json")

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $PSScriptRoot "backups/cloudbase"
$backupDir = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Write-Host ""
Write-Host "[2/6] Exporting current data to local JSON backup..."
foreach ($collection in @("couples", "couple_users", "ratings")) {
    Write-Host ("  Dumping " + $collection + "...")
    Run-Tcb @(
        "db", "nosql", "dump", $collection,
        "--file-type", "json",
        "--output-dir", $backupDir,
        "--env-id", $envId
    )
}

$backupFiles = @(Get-ChildItem -Path $backupDir -File -Recurse -ErrorAction SilentlyContinue)
if ($backupFiles.Count -lt 3) {
    Fail "Backup did not produce at least three files. No database changes were made." 24
}

Write-Host ("  Backup saved to: " + $backupDir) -ForegroundColor Green

Write-Host ""
Write-Host "[3/6] Saving pre-migration audit..."
$waitingAudit = Join-Path $backupDir "audit_waiting_missing_invite.json"
$duplicateAudit = Join-Path $backupDir "audit_duplicate_invites_before.json"

$waitingCmd = '{"find":"couples","filter":{"status":"waiting","$or":[{"inviteCode":null},{"inviteCode":{"$exists":false}}]},"projection":{"_id":1,"status":1,"inviteCode":1}}'
$duplicateCmd = '{"aggregate":"couples","pipeline":[{"$group":{"_id":"$inviteCode","n":{"$sum":1},"ids":{"$push":"$_id"}}},{"$match":{"n":{"$gt":1}}}],"cursor":{}}'

& tcb db nosql execute --command $waitingCmd --env-id $envId --json |
    Out-File -FilePath $waitingAudit -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    Fail "Could not audit waiting invitations. Backup is safe; no data was modified." 25
}

& tcb db nosql execute --command $duplicateCmd --env-id $envId --json |
    Out-File -FilePath $duplicateAudit -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    Fail "Could not audit duplicate invite codes. Backup is safe; no data was modified." 26
}

Write-Host ""
Write-Host "[4/6] Normalizing legacy used inviteCode values..."
$normalizeCmd = '{"update":"couples","updates":[{"q":{"status":{"$ne":"waiting"},"$or":[{"inviteCode":null},{"inviteCode":{"$exists":false}}]},"u":[{"$set":{"inviteCode":{"$concat":["USED_",{"$toString":"$_id"}]}}}],"multi":true}]}'
Run-NoSql $envId $normalizeCmd

Write-Host ""
Write-Host "[5/6] Checking duplicate invite codes after normalization..."
$afterAudit = Join-Path $backupDir "audit_duplicate_invites_after.json"
& tcb db nosql execute --command $duplicateCmd --env-id $envId --json |
    Out-File -FilePath $afterAudit -Encoding utf8
if ($LASTEXITCODE -ne 0) {
    Fail "Post-migration duplicate audit failed. Do not create indexes yet." 27
}

if ($SkipIndexes) {
    Write-Host ""
    Write-Host "[SKIP] Index creation skipped by -SkipIndexes."
    Write-Host ("Backup/audit directory: " + $backupDir)
    exit 0
}

Write-Host ""
Write-Host "[6/6] Creating indexes..."

$couplesIndexCmd = '{"createIndexes":"couples","indexes":[{"key":{"inviteCode":1},"name":"idx_inviteCode_unique","unique":true}]}'
$ratingsIndexCmd = '{"createIndexes":"ratings","indexes":[{"key":{"coupleId":1,"date":-1,"ratedBy":1},"name":"idx_couple_date_ratedBy"}]}'

Write-Host "  couples -> idx_inviteCode_unique"
try {
    Run-NoSql $envId $couplesIndexCmd
} catch {
    Write-Host ""
    Write-Host "[STOP] Unique invite index could not be created." -ForegroundColor Red
    Write-Host "Current data backup is already safe."
    Write-Host ("Inspect: " + $afterAudit)
    throw
}

Write-Host "  ratings -> idx_couple_date_ratedBy"
Run-NoSql $envId $ratingsIndexCmd

Write-Host ""
Write-Host "===================================================="
Write-Host " DONE"
Write-Host "===================================================="
Write-Host ("Backup: " + $backupDir) -ForegroundColor Green
Write-Host "Indexes:"
Write-Host "  couples: idx_inviteCode_unique (UNIQUE, inviteCode ASC)"
Write-Host "  ratings: idx_couple_date_ratedBy (coupleId ASC, date DESC, ratedBy ASC)"
Write-Host ""
Write-Host "Keep the backup directory until you have tested binding and review pages."
