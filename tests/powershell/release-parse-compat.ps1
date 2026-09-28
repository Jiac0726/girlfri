$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$files = @(
    "scripts/release-cloudbase-apply.ps1",
    "scripts/release-cloudbase-audit.ps1"
)

foreach ($relative in $files) {
    $path = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $path)) {
        throw ("Missing release script: " + $relative)
    }

    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path -LiteralPath $path).Path,
        [ref]$tokens,
        [ref]$errors
    )

    if ($errors.Count -gt 0) {
        Write-Host ("Windows PowerShell 5.1 parse errors in " + $relative)
        foreach ($errorItem in $errors) {
            Write-Host $errorItem.Message
        }
        exit 1
    }

    $raw = [System.IO.File]::ReadAllText($path)
    if ($raw -match "[^\x00-\x7F]") {
        throw ("Release script must stay ASCII-only for Windows PowerShell 5.1 compatibility: " + $relative)
    }
}

Write-Host "Release scripts parse successfully in Windows PowerShell 5.1 and are ASCII-only."
