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

Write-Host ""
Write-Host "===================================================="
Write-Host " RENIAN RELEASE CLOUDBASE AUDIT (READ ONLY)"
Write-Host "===================================================="
Write-Host ("Environment: " + $EnvId)
Write-Host "This script does NOT modify cloud resources."
Write-Host ""

$functions = @("renianApi", "dailyReminder", "mediaCleanup")
foreach ($name in $functions) {
    Write-Host ""
    Write-Host ("---------------- FUNCTION: " + $name + " ----------------")
    $detail = Invoke-Tcb -Capture -TcbArgs @(
        "fn", "detail", $name,
        "--env-id", $EnvId
    )
    Write-Host $detail
}

Write-Host ""
Write-Host "---------------- DATABASE CLIENT ACL ----------------"

$releaseCollections = @(Get-RenianReleaseDatabaseCollections)
foreach ($collection in $releaseCollections) {
    $acl = Get-DatabaseAclTag -EnvId $EnvId -Collection $collection
    Write-Host ("  " + $collection + " = " + $acl)
    if ($acl -ne "ADMINONLY") {
        throw ("Release database ACL is unsafe for '" + $collection + "': expected ADMINONLY, got " + $acl)
    }
}

foreach ($collection in @("couple_users", "couples", "ratings")) {
    try {
        $acl = Get-DatabaseAclTag -EnvId $EnvId -Collection $collection
        Write-Host ("  legacy " + $collection + " = " + $acl)
        if ($acl -ne "ADMINONLY") {
            throw ("Legacy database ACL is unsafe for '" + $collection + "': expected ADMINONLY, got " + $acl)
        }
    } catch {
        $message = [string]$_.Exception.Message
        if ($message -match "ResourceNotFound|NotFound|not exist|does not exist|不存在") {
            Write-Host ("  legacy collection absent, skipped: " + $collection)
        } else {
            throw
        }
    }
}

function Get-IndexList {
    param([Parameter(Mandatory = $true)][string]$Collection)

    $inner = ([ordered]@{
        listIndexes = $Collection
    } | ConvertTo-Json -Compress)

    $mgoCommand = [ordered]@{
        TableName = $Collection
        CommandType = "COMMAND"
        Command = $inner
    }

    [object[]]$commands = @($mgoCommand)
    $outer = ConvertTo-Json -InputObject $commands -Depth 20 -Compress

    Write-Host ""
    Write-Host ("---------------- INDEXES: " + $Collection + " ----------------")
    Write-Host (Invoke-NoSql -EnvId $EnvId -CommandJson $outer)
}

$collections = @(
    "v2_media",
    "v2_operations",
    "v2_albums",
    "v2_album_photos",
    "v2_album_comments"
)

foreach ($collection in $collections) {
    Get-IndexList -Collection $collection
}

Write-Host ""
Write-Host "===================================================="
Write-Host " AUDIT COMPLETE"
Write-Host "===================================================="
Write-Host "Expected release function settings:"
Write-Host "  renianApi     timeout=60s memory=512MB"
Write-Host "  dailyReminder timeout=60s memory=256MB trigger=dailyRatingReminderTimer"
Write-Host "  mediaCleanup  timeout=60s memory=256MB trigger=abandonedMediaCleanup"
Write-Host ""
Write-Host "Expected database ACL:"
Write-Host "  all release v2 collections = ADMINONLY"
Write-Host "  retained legacy collections = ADMINONLY"
Write-Host ""
Write-Host "Expected release indexes include:"
Write-Host "  v2_media.v2_query_15"
Write-Host "  v2_operations.v2_query_16"
Write-Host "  v2_albums.album_list"
Write-Host "  v2_album_photos.album_photos"
Write-Host "  v2_album_comments.album_comments"
