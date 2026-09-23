$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts/database-common.ps1')

$root = Join-Path $env:TEMP ('renian-preflight-compat-' + [Guid]::NewGuid().ToString('N'))
try {
    foreach ($name in @('couples', 'couple_users', 'ratings')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $root ('raw/' + $name)) | Out-Null
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        (Join-Path $root 'raw/couples/data.json'),
        "{`"_id`":`"pair_wait`",`"status`":`"waiting`",`"inviteCode`":`"ABCDEFGH`"}" + [Environment]::NewLine +
        "{`"_id`":`"pair_active`",`"status`":`"active`",`"inviteCode`":`"`"}" + [Environment]::NewLine,
        $utf8
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $root 'raw/couple_users/data.json'),
        "{`"_id`":`"u1`",`"coupleId`":`"pair_active`"}" + [Environment]::NewLine,
        $utf8
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $root 'raw/ratings/data.json'),
        "{`"_id`":`"r1`",`"coupleId`":`"pair_active`",`"date`":`"2026-09-23`",`"ratedBy`":`"u1`"}" + [Environment]::NewLine,
        $utf8
    )

    $report = Analyze-RenianBackup -EnvId 'fixture-env' -BackupDir $root

    if (-not $report.safeToMigrate) { throw 'Fixture should be safe to migrate.' }
    if ($report.counts.couples -ne 2) { throw 'Expected 2 couples.' }
    if ($report.counts.coupleUsers -ne 1) { throw 'Expected 1 couple user.' }
    if ($report.counts.ratings -ne 1) { throw 'Expected 1 rating.' }
    if (@($report.couples.normalizationCandidates).Count -ne 1) { throw 'Expected 1 normalization candidate.' }

    Write-PreflightReport -Report $report -BackupDir $root | Out-Null

    if (-not (Test-Path (Join-Path $root 'PRECHECK.txt'))) { throw 'PRECHECK.txt was not created.' }
    if (-not (Test-Path (Join-Path $root 'preflight-report.json'))) { throw 'preflight-report.json was not created.' }

    Write-Host ('Preflight compatibility test passed on PowerShell ' + $PSVersionTable.PSVersion)
}
finally {
    Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
