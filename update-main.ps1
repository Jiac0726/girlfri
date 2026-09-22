$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$Message, [int]$Code = 1) {
    Write-Host ""
    Write-Host ("[ERROR] " + $Message) -ForegroundColor Red
    exit $Code
}

function RunGit([string[]]$Args) {
    & git @Args
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

Write-Host ""
Write-Host "==============================================="
Write-Host " Renian - Update local main from origin/main"
Write-Host "==============================================="
Write-Host ""

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "Git was not found in PATH."
}

if (-not (Test-Path ".git")) {
    Fail "Place update-main.cmd and update-main.ps1 in the girfri repository root."
}

# Only tracked modifications can block the update.
# Untracked backups, ZIP files, temporary folders, etc. are intentionally ignored.
Write-Host "[1/8] Checking tracked local changes..."

$allowedTracked = @(
    "app.js",
    "project.config.json",
    "update-main.cmd",
    "update-main.ps1"
)

$unstaged = @(& git diff --name-only)
if ($LASTEXITCODE -ne 0) { Fail "Could not inspect unstaged changes." }

$staged = @(& git diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { Fail "Could not inspect staged changes." }

$trackedChanges = @(
    $unstaged + $staged |
    Where-Object { $_ } |
    Sort-Object -Unique
)

$unsafe = @(
    $trackedChanges |
    Where-Object { $_ -notin $allowedTracked }
)

if ($unsafe.Count -gt 0) {
    Write-Host ""
    Write-Host "[STOP] Tracked local code changes were found:" -ForegroundColor Yellow
    foreach ($f in $unsafe) {
        Write-Host ("  - " + $f) -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Commit or stash these tracked changes before updating."
    exit 23
}

Write-Host "[2/8] Reading local AppID and Cloud ENV..."

$appid = ""
$envId = ""

if (Test-Path "project.config.json") {
    $cfgText = Get-Content "project.config.json" -Raw
    $m = [regex]::Match($cfgText, '"appid"\s*:\s*"([^"]*)"')
    if ($m.Success) {
        $appid = $m.Groups[1].Value
    }
}

if (Test-Path "app.js") {
    $appText = Get-Content "app.js" -Raw
    $m = [regex]::Match($appText, "env\s*:\s*['""]([^'""]+)['""]")
    if ($m.Success) {
        $envId = $m.Groups[1].Value
    }
}

Write-Host ("  AppID: " + $(if ($appid) { $appid } else { "<not found>" }))
Write-Host ("  ENV:   " + $(if ($envId) { $envId } else { "<not found>" }))

$backupPath = Join-Path $PSScriptRoot ".renian-local-config.json"
$backup = @{
    appid = $appid
    envId = $envId
} | ConvertTo-Json -Compress

[System.IO.File]::WriteAllText(
    $backupPath,
    $backup,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "[3/8] Temporarily restoring tracked local config files..."

foreach ($f in @("app.js", "project.config.json")) {
    & git ls-files --error-unmatch -- $f *> $null
    if ($LASTEXITCODE -eq 0) {
        RunGit @("restore", "--source=HEAD", "--", $f)
    }
}

Write-Host "[4/8] Switching to main..."
RunGit @("switch", "main")

Write-Host "[5/8] Fetching origin..."
RunGit @("fetch", "origin")

Write-Host "[6/8] Pulling latest main..."
RunGit @("pull", "--ff-only", "origin", "main")

Write-Host "[7/8] Restoring local AppID and Cloud ENV..."

if ((Test-Path "project.config.json") -and $appid -and $appid -ne "wxYOUR_APPID") {
    $cfgText = Get-Content "project.config.json" -Raw
    $cfgText = [regex]::Replace(
        $cfgText,
        '"appid"\s*:\s*"[^"]*"',
        ('"appid": "' + $appid + '"'),
        1
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $PSScriptRoot "project.config.json"),
        $cfgText,
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-Host "  AppID restored."
}

if ((Test-Path "app.js") -and $envId -and $envId -ne "YOUR_ENV_ID") {
    $appText = Get-Content "app.js" -Raw
    $appText = [regex]::Replace(
        $appText,
        "env\s*:\s*['""][^'""]+['""]",
        ("env: '" + $envId + "'"),
        1
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $PSScriptRoot "app.js"),
        $appText,
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-Host "  Cloud ENV restored."
}

Remove-Item $backupPath -Force -ErrorAction SilentlyContinue

Write-Host "[8/8] Done."
Write-Host ""
Write-Host "Latest commit:"
& git log -1 --oneline

Write-Host ""
Write-Host "Tracked working tree status:"
& git status --short --untracked-files=no

Write-Host ""
Write-Host "NOTE:"
Write-Host "- Untracked files do not block updates."
Write-Host "- app.js/project.config.json may stay modified because local AppID/ENV are restored."
Write-Host "- If renianApi changed, redeploy it in WeChat DevTools."

exit 0
