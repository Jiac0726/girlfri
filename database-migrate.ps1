param(
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

. (Join-Path $PSScriptRoot "scripts/database-common.ps1")

function Invoke-NormalizationBatch {
    param(
        [Parameter(Mandatory = $true)][string]$EnvId,
        [Parameter(Mandatory = $true)][object[]]$Items
    )

    $updates = @()
    foreach ($item in $Items) {
        $updates += [ordered]@{
            q = [ordered]@{
                _id = [string]$item.id
                status = [ordered]@{ '$ne' = "waiting" }
            }
            u = [ordered]@{
                '$set' = [ordered]@{
                    inviteCode = [string]$item.targetInviteCode
                }
            }
            multi = $false
        }
    }

    if ($updates.Count -eq 0) { return "" }

    $command = [ordered]@{
        update = "couples"
        updates = $updates
    } | ConvertTo-Json -Depth 10 -Compress

    return Invoke-NoSql -EnvId $EnvId -CommandJson $command
}

Write-Host ""
Write-Host "===================================================="
Write-Host " Renian - CloudBase MIGRATION"
Write-Host "===================================================="
Write-Host ""
Write-Host "This command WILL modify couples.inviteCode and create indexes."
Write-Host "A fresh full backup + audit is always created before any write."
Write-Host ""

try {
    $report = New-RenianPreflight

    if (-not $report.safeToMigrate) {
        Write-Host ""
        Write-Host "[STOP] Pre-flight blockers exist. Database was NOT modified." -ForegroundColor Red
        Write-Host ("Open: " + (Join-Path $report.backupDir "PRECHECK.txt"))
        exit 30
    }

    $candidates = @($report.couples.normalizationCandidates)

    Write-Host ""
    Write-Host ("Backup: " + $report.backupDir) -ForegroundColor Green
    Write-Host ("Non-waiting inviteCodes to normalize: " + $candidates.Count)
    Write-Host "Indexes to create:"
    Write-Host "  couples: idx_inviteCode_unique (UNIQUE, inviteCode ASC)"
    Write-Host "  ratings: idx_couple_date_ratedBy (coupleId ASC, date DESC, ratedBy ASC)"
    Write-Host ""

    if (-not $Yes) {
        $answer = Read-Host "Type MIGRATE to continue"
        if ($answer -ne "MIGRATE") {
            Write-Host "[CANCELLED] Nothing was changed."
            exit 31
        }
    }

    $envId = [string]$report.envId
    $migrationLog = New-Object System.Collections.Generic.List[string]

    if ($candidates.Count -gt 0) {
        Write-Host ""
        Write-Host "[1/3] Normalizing legacy non-waiting inviteCode values..."

        $batchSize = 100
        for ($i = 0; $i -lt $candidates.Count; $i += $batchSize) {
            $end = [Math]::Min($i + $batchSize - 1, $candidates.Count - 1)
            $batch = @($candidates[$i..$end])
            $result = Invoke-NormalizationBatch -EnvId $envId -Items $batch
            $migrationLog.Add([string]$result)
            Write-Host ("  updated candidate batch " + ($i + 1) + "-" + ($end + 1))
        }
    } else {
        Write-Host ""
        Write-Host "[1/3] No legacy inviteCode values need normalization."
    }

    Write-Host ""
    Write-Host "[2/3] Creating database indexes..."

    $couplesIndexCmd = '{"createIndexes":"couples","indexes":[{"key":{"inviteCode":1},"name":"idx_inviteCode_unique","unique":true}]}'
    $ratingsIndexCmd = '{"createIndexes":"ratings","indexes":[{"key":{"coupleId":1,"date":-1,"ratedBy":1},"name":"idx_couple_date_ratedBy"}]}'

    $couplesResult = Invoke-NoSql -EnvId $envId -CommandJson $couplesIndexCmd
    $migrationLog.Add([string]$couplesResult)
    Write-Host "  couples.idx_inviteCode_unique OK" -ForegroundColor Green

    $ratingsResult = Invoke-NoSql -EnvId $envId -CommandJson $ratingsIndexCmd
    $migrationLog.Add([string]$ratingsResult)
    Write-Host "  ratings.idx_couple_date_ratedBy OK" -ForegroundColor Green

    [System.IO.File]::WriteAllLines(
        (Join-Path $report.backupDir "migration-command.log"),
        $migrationLog,
        [System.Text.UTF8Encoding]::new($false)
    )

    $receipt = [ordered]@{
        migratedAt = (Get-Date).ToString("o")
        envId = $envId
        preMigrationBackup = $report.backupDir
        normalizedInviteCodes = $candidates.Count
        indexes = @(
            [ordered]@{
                collection = "couples"
                name = "idx_inviteCode_unique"
                unique = $true
                key = [ordered]@{ inviteCode = 1 }
            },
            [ordered]@{
                collection = "ratings"
                name = "idx_couple_date_ratedBy"
                unique = $false
                key = [ordered]@{ coupleId = 1; date = -1; ratedBy = 1 }
            }
        )
    }

    [System.IO.File]::WriteAllText(
        (Join-Path $report.backupDir "MIGRATION-RECEIPT.json"),
        ($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )

    Write-Host ""
    Write-Host "[3/3] Creating post-migration backup + audit..."
    $post = New-RenianPreflight

    if (-not $post.safeToMigrate -or @($post.couples.normalizationCandidates).Count -gt 0) {
        Write-Host ""
        Write-Host "[WARNING] Migration commands completed, but post-flight audit found issues." -ForegroundColor Yellow
        Write-Host ("Post-flight report: " + (Join-Path $post.backupDir "PRECHECK.txt"))
        exit 32
    }

    Write-Host ""
    Write-Host "===================================================="
    Write-Host " MIGRATION COMPLETE" -ForegroundColor Green
    Write-Host "===================================================="
    Write-Host ("Pre-migration backup:  " + $report.backupDir)
    Write-Host ("Post-migration backup: " + $post.backupDir)
    Write-Host ""
    exit 0
} catch {
    Write-Host ""
    Write-Host ("[ERROR] " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "If a pre-migration backup path was printed above, keep it untouched."
    exit 1
}
