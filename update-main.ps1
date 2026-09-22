param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
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
    Fail "Run this script from the girfri repository root."
}

Write-Host "[1/5] Checking tracked local changes..."

$unstaged = @(& git diff --name-only)
if ($LASTEXITCODE -ne 0) { Fail "Could not inspect unstaged changes." }

$staged = @(& git diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { Fail "Could not inspect staged changes." }

$trackedChanges = @(
    $unstaged + $staged |
    Where-Object { $_ } |
    Sort-Object -Unique
)

if ($trackedChanges.Count -gt 0) {
    if ($Force) {
        Write-Host "[FORCE] Discarding tracked local changes:" -ForegroundColor Yellow
        foreach ($f in $trackedChanges) {
            Write-Host ("  - " + $f) -ForegroundColor Yellow
        }
        RunGit @("reset", "--hard", "HEAD")
    } else {
        Write-Host ""
        Write-Host "[STOP] Tracked local code changes were found:" -ForegroundColor Yellow
        foreach ($f in $trackedChanges) {
            Write-Host ("  - " + $f) -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "Use update-main-force.cmd only if you want to discard them."
        exit 23
    }
}

Write-Host "[2/5] Switching to main..."
RunGit @("switch", "main")

Write-Host "[3/5] Fetching origin..."
RunGit @("fetch", "origin")

if ($Force) {
    Write-Host "[4/5] Resetting main to origin/main..."
    RunGit @("reset", "--hard", "origin/main")
} else {
    Write-Host "[4/5] Pulling latest main..."
    RunGit @("pull", "--ff-only", "origin", "main")
}

Write-Host "[5/5] Done."
Write-Host ""
Write-Host "Latest commit:"
& git log -1 --oneline

Write-Host ""
Write-Host "Tracked working tree status:"
& git status --short --untracked-files=no

Write-Host ""
if (-not (Test-Path "project.private.config.json")) {
    Write-Host "[NOTE] project.private.config.json is missing. Run setup-local.cmd once." -ForegroundColor Yellow
}
if (-not (Test-Path "config/env.local.js")) {
    Write-Host "[NOTE] config/env.local.js is missing. Run setup-local.cmd once." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Local AppID and Cloud ENV are stored in Git-ignored files."
Write-Host "They are not touched by update-main.cmd or update-main-force.cmd."
Write-Host ""

exit 0
