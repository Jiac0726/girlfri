$ErrorActionPreference = "Stop"

$script:RenianRepoRoot = Split-Path -Parent $PSScriptRoot
$script:InviteAlphabetRegex = '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'

function Assert-Tcb {
    if (-not (Get-Command tcb -ErrorAction SilentlyContinue)) {
        throw "CloudBase CLI not found. Install with: npm i -g @cloudbase/cli ; then run: tcb login"
    }
}

function Get-RenianEnvId {
    $envFile = Join-Path $script:RenianRepoRoot "config/env.local.js"
    if (-not (Test-Path $envFile)) {
        throw "config/env.local.js is missing. Run setup-local.cmd first."
    }

    $text = Get-Content -LiteralPath $envFile -Raw
    $m = [regex]::Match($text, 'cloudEnv\s*:\s*[''"]([^''"]+)[''"]')
    if (-not $m.Success) {
        throw "Could not read cloudEnv from config/env.local.js."
    }

    $envId = $m.Groups[1].Value.Trim()
    if (-not $envId -or $envId -eq "YOUR_ENV_ID") {
        throw "Cloud environment ID is not configured."
    }

    return $envId
}

function Invoke-Tcb {
    param(
        [Parameter(Mandatory = $true)][string[]]$TcbArgs,
        [switch]$Capture
    )

    if ($Capture) {
        $lines = @(& tcb @TcbArgs 2>&1)
        $code = $LASTEXITCODE
        $text = ($lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        if ($code -ne 0) {
            throw ("tcb " + ($TcbArgs -join " ") + " failed with exit code " + $code + [Environment]::NewLine + $text)
        }
        return $text
    }

    & tcb @TcbArgs | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw ("tcb " + ($TcbArgs -join " ") + " failed with exit code " + $LASTEXITCODE)
    }
}

function ConvertTo-TcbJsonArgument {
    param([Parameter(Mandatory = $true)][string]$Json)

    # Windows PowerShell 5.1 rebuilds the native command line and strips the
    # unescaped quotes inside JSON when an npm PowerShell shim ultimately calls
    # node.exe. Backslash-escaping preserves the JSON quotes for the native argv.
    if ($PSVersionTable.PSEdition -eq "Desktop" -and $env:OS -eq "Windows_NT") {
        return $Json.Replace('"', '\"')
    }

    return $Json
}

function ConvertTo-TcbMgoCommandsJson {
    param([Parameter(Mandatory = $true)][string]$CommandJson)

    $trimmed = $CommandJson.Trim()
    if (-not $trimmed) {
        throw "CloudBase NoSQL command JSON must not be empty."
    }

    try {
        $parsed = $trimmed | ConvertFrom-Json
    } catch {
        throw ("CloudBase NoSQL command is not valid JSON. " + $_.Exception.Message)
    }

    if ($trimmed.StartsWith("[")) {
        return $trimmed
    }

    return "[" + $trimmed + "]"
}

function Invoke-NoSql {
    param(
        [Parameter(Mandatory = $true)][string]$EnvId,
        [Parameter(Mandatory = $true)][string]$CommandJson
    )

    # CloudBase CLI 3.8.x validates --command as an MgoCommands JSON array.
    # Keep callers ergonomic by accepting one command object and wrapping it.
    $commandsJson = ConvertTo-TcbMgoCommandsJson -CommandJson $CommandJson
    $commandArg = ConvertTo-TcbJsonArgument -Json $commandsJson

    return Invoke-Tcb -Capture -TcbArgs @(
        "db", "nosql", "execute",
        "--command", $commandArg,
        "--env-id", $EnvId,
        "--json"
    )
}

function Export-RenianCollection {
    param(
        [Parameter(Mandatory = $true)][string]$EnvId,
        [Parameter(Mandatory = $true)][string]$Collection,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null

    $log = Invoke-Tcb -Capture -TcbArgs @(
        "db", "nosql", "dump", $Collection,
        "--file-type", "json",
        "--output-dir", $Destination,
        "--env-id", $EnvId,
        "--json"
    )

    [System.IO.File]::WriteAllText(
        (Join-Path $Destination "_dump-command.log"),
        $log + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )

    $jsonFiles = @(
        Get-ChildItem -LiteralPath $Destination -Recurse -File -Filter "*.json" |
        Where-Object { $_.Name -notlike "audit_*" -and $_.Name -ne "preflight-report.json" }
    )

    if ($jsonFiles.Count -eq 0) {
        throw ("No JSON dump file was produced for collection '" + $Collection + "'.")
    }

    return @($jsonFiles.FullName)
}

function Read-JsonDumpFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    $trimmed = $raw.Trim()

    if ($trimmed.StartsWith("[")) {
        $parsed = $trimmed | ConvertFrom-Json
        return @($parsed)
    }

    $rows = New-Object System.Collections.Generic.List[object]
    $lineNo = 0
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $lineNo += 1
        $t = $line.Trim()
        if (-not $t) { continue }

        try {
            $rows.Add(($t | ConvertFrom-Json))
        } catch {
            throw ("Invalid JSON Lines data in '" + $Path + "' at line " + $lineNo + ". " + $_.Exception.Message)
        }
    }

    return $rows.ToArray()
}

function Read-CollectionDump {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $files = @(
        Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter "*.json" |
        Where-Object { $_.Name -notlike "audit_*" -and $_.Name -ne "preflight-report.json" }
    )

    $all = New-Object System.Collections.Generic.List[object]
    foreach ($file in $files) {
        foreach ($row in (Read-JsonDumpFile -Path $file.FullName)) {
            $all.Add($row)
        }
    }

    return $all.ToArray()
}

function Get-PropValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Analyze-RenianBackup {
    param(
        [Parameter(Mandatory = $true)][string]$EnvId,
        [Parameter(Mandatory = $true)][string]$BackupDir
    )

    $couples = @(Read-CollectionDump -Directory (Join-Path $BackupDir "raw/couples"))
    $users = @(Read-CollectionDump -Directory (Join-Path $BackupDir "raw/couple_users"))
    $ratings = @(Read-CollectionDump -Directory (Join-Path $BackupDir "raw/ratings"))

    $waitingInvalid = New-Object System.Collections.Generic.List[object]
    $normalizationCandidates = New-Object System.Collections.Generic.List[object]
    $missingCoupleIds = New-Object System.Collections.Generic.List[object]
    $waitingCodes = @{}

    foreach ($doc in $couples) {
        $id = [string](Get-PropValue -Object $doc -Name "_id")
        $status = [string](Get-PropValue -Object $doc -Name "status")
        $inviteRaw = Get-PropValue -Object $doc -Name "inviteCode"
        $invite = if ($null -eq $inviteRaw) { "" } else { [string]$inviteRaw }

        if (-not $id) {
            $missingCoupleIds.Add([ordered]@{ status = $status; inviteCode = $invite })
            continue
        }

        if ($status -eq "waiting") {
            if ($invite -notmatch $script:InviteAlphabetRegex) {
                $waitingInvalid.Add([ordered]@{
                    id = $id
                    inviteCode = $invite
                    reason = "waiting inviteCode must be exactly 8 chars from the production alphabet"
                })
            } else {
                if (-not $waitingCodes.ContainsKey($invite)) {
                    $waitingCodes[$invite] = New-Object System.Collections.Generic.List[string]
                }
                $waitingCodes[$invite].Add($id)
            }
        } else {
            $expected = "USED_" + $id
            if ($invite -ne $expected) {
                $normalizationCandidates.Add([ordered]@{
                    id = $id
                    status = $status
                    currentInviteCode = $invite
                    targetInviteCode = $expected
                })
            }
        }
    }

    $waitingDuplicates = New-Object System.Collections.Generic.List[object]
    foreach ($key in $waitingCodes.Keys) {
        $ids = $waitingCodes[$key].ToArray()
        if ($ids.Count -gt 1) {
            $waitingDuplicates.Add([ordered]@{
                inviteCode = $key
                ids = $ids
                count = $ids.Count
            })
        }
    }

    $userIssues = New-Object System.Collections.Generic.List[object]
    foreach ($doc in $users) {
        $id = [string](Get-PropValue -Object $doc -Name "_id")
        $coupleId = [string](Get-PropValue -Object $doc -Name "coupleId")
        if (-not $id -or -not $coupleId) {
            $userIssues.Add([ordered]@{ id = $id; coupleId = $coupleId })
        }
    }

    $ratingIssues = New-Object System.Collections.Generic.List[object]
    $ratingKeys = @{}
    $ratingDuplicates = New-Object System.Collections.Generic.List[object]
    foreach ($doc in $ratings) {
        $id = [string](Get-PropValue -Object $doc -Name "_id")
        $coupleId = [string](Get-PropValue -Object $doc -Name "coupleId")
        $date = [string](Get-PropValue -Object $doc -Name "date")
        $ratedBy = [string](Get-PropValue -Object $doc -Name "ratedBy")

        if (-not $coupleId -or -not $date -or -not $ratedBy) {
            $ratingIssues.Add([ordered]@{
                id = $id
                coupleId = $coupleId
                date = $date
                ratedBy = $ratedBy
            })
            continue
        }

        $key = $coupleId + "|" + $date + "|" + $ratedBy
        if ($ratingKeys.ContainsKey($key)) {
            $ratingDuplicates.Add([ordered]@{
                key = $key
                firstId = $ratingKeys[$key]
                duplicateId = $id
            })
        } else {
            $ratingKeys[$key] = $id
        }
    }

    $blockingCount = $missingCoupleIds.Count + $waitingInvalid.Count + $waitingDuplicates.Count
    $warningCount = $userIssues.Count + $ratingIssues.Count + $ratingDuplicates.Count

    return [ordered]@{
        reportVersion = 2
        generatedAt = (Get-Date).ToString("o")
        envId = $EnvId
        backupDir = $BackupDir
        safeToMigrate = ($blockingCount -eq 0)
        blockingIssueCount = $blockingCount
        warningCount = $warningCount
        counts = [ordered]@{
            couples = $couples.Count
            coupleUsers = $users.Count
            ratings = $ratings.Count
        }
        couples = [ordered]@{
            missingIds = $missingCoupleIds.ToArray()
            waitingInvalid = $waitingInvalid.ToArray()
            waitingDuplicates = $waitingDuplicates.ToArray()
            normalizationCandidates = $normalizationCandidates.ToArray()
        }
        warnings = [ordered]@{
            coupleUsersMissingIdentityOrCouple = $userIssues.ToArray()
            ratingsMissingIndexFields = $ratingIssues.ToArray()
            duplicateRatingLogicalKeys = $ratingDuplicates.ToArray()
        }
    }
}

function Write-PreflightReport {
    param(
        [Parameter(Mandatory = $true)]$Report,
        [Parameter(Mandatory = $true)][string]$BackupDir
    )

    $jsonPath = Join-Path $BackupDir "preflight-report.json"
    $textPath = Join-Path $BackupDir "PRECHECK.txt"

    $json = $Report | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText(
        $jsonPath,
        $json + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )

    $lines = @(
        "Renian CloudBase preflight",
        "==========================",
        "Generated: " + $Report.generatedAt,
        "Environment: " + $Report.envId,
        "Backup: " + $Report.backupDir,
        "",
        "Counts:",
        "  couples:      " + $Report.counts.couples,
        "  couple_users: " + $Report.counts.coupleUsers,
        "  ratings:      " + $Report.counts.ratings,
        "",
        "Migration blockers:",
        "  missing couple _id:       " + @($Report.couples.missingIds).Count,
        "  invalid waiting invites:  " + @($Report.couples.waitingInvalid).Count,
        "  duplicate waiting codes:  " + @($Report.couples.waitingDuplicates).Count,
        "",
        "Will normalize non-waiting inviteCode: " + @($Report.couples.normalizationCandidates).Count,
        "Warnings: " + $Report.warningCount,
        "",
        "SAFE TO MIGRATE: " + $Report.safeToMigrate
    )

    [System.IO.File]::WriteAllLines(
        $textPath,
        $lines,
        [System.Text.UTF8Encoding]::new($false)
    )

    return $jsonPath
}

function New-RenianPreflight {
    Assert-Tcb
    $envId = Get-RenianEnvId

    Write-Host ("Environment: " + $envId)
    Write-Host "Checking CloudBase access..."
    Invoke-Tcb -TcbArgs @("env", "info", "--env-id", $envId, "--json")

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $backupDir = Join-Path $script:RenianRepoRoot ("backups/cloudbase/" + $stamp)
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    foreach ($collection in @("couples", "couple_users", "ratings")) {
        Write-Host ("Exporting " + $collection + "...")
        Export-RenianCollection -EnvId $envId -Collection $collection -Destination (Join-Path $backupDir ("raw/" + $collection)) | Out-Null
    }

    $report = Analyze-RenianBackup -EnvId $envId -BackupDir $backupDir
    Write-PreflightReport -Report $report -BackupDir $backupDir | Out-Null

    return $report
}
