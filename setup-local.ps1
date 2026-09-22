param(
    [string]$AppId = "",
    [string]$CloudEnv = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Read-Default([string]$Prompt, [string]$DefaultValue) {
    if ($DefaultValue) {
        $value = Read-Host "$Prompt [$DefaultValue]"
        if ([string]::IsNullOrWhiteSpace($value)) {
            return $DefaultValue
        }
        return $value.Trim()
    }

    return (Read-Host $Prompt).Trim()
}

if (-not $AppId -and (Test-Path "project.private.config.json")) {
    try {
        $private = Get-Content "project.private.config.json" -Raw | ConvertFrom-Json
        $AppId = [string]$private.appid
    } catch {}
}

if (-not $AppId -and (Test-Path "project.config.json")) {
    try {
        $public = Get-Content "project.config.json" -Raw | ConvertFrom-Json
        $candidate = [string]$public.appid
        if ($candidate -and $candidate -ne "wxYOUR_APPID") {
            $AppId = $candidate
        }
    } catch {}
}

if (-not $AppId -and (Test-Path "project.config.local.bak.json")) {
    try {
        $backup = Get-Content "project.config.local.bak.json" -Raw | ConvertFrom-Json
        $candidate = [string]$backup.appid
        if ($candidate -and $candidate -ne "wxYOUR_APPID") {
            $AppId = $candidate
        }
    } catch {}
}

if (-not $CloudEnv -and (Test-Path "config/env.local.js")) {
    $text = Get-Content "config/env.local.js" -Raw
    $m = [regex]::Match($text, "cloudEnv\s*:\s*['""]([^'""]+)['""]")
    if ($m.Success) {
        $CloudEnv = $m.Groups[1].Value
    }
}

if (-not $CloudEnv -and (Test-Path "app.js")) {
    $text = Get-Content "app.js" -Raw
    $m = [regex]::Match($text, "env\s*:\s*['""]([^'""]+)['""]")
    if ($m.Success -and $m.Groups[1].Value -ne "YOUR_ENV_ID") {
        $CloudEnv = $m.Groups[1].Value
    }
}

if (-not $CloudEnv -and (Test-Path "app.local.bak.js")) {
    $text = Get-Content "app.local.bak.js" -Raw
    $m = [regex]::Match($text, "env\s*:\s*['""]([^'""]+)['""]")
    if ($m.Success -and $m.Groups[1].Value -ne "YOUR_ENV_ID") {
        $CloudEnv = $m.Groups[1].Value
    }
}

Write-Host ""
Write-Host "Renian local configuration"
Write-Host "--------------------------"

$AppId = Read-Default "WeChat AppID" $AppId
$CloudEnv = Read-Default "Cloud environment ID" $CloudEnv

if (-not $AppId.StartsWith("wx") -or $AppId.Length -lt 5) {
    throw "Invalid AppID. Expected a value beginning with wx."
}

if ([string]::IsNullOrWhiteSpace($CloudEnv) -or $CloudEnv -eq "YOUR_ENV_ID") {
    throw "Invalid cloud environment ID."
}

$privateJson = [ordered]@{
    description = "Local WeChat DevTools configuration. This file is ignored by Git."
    appid = $AppId
} | ConvertTo-Json -Depth 5

[System.IO.File]::WriteAllText(
    (Join-Path $PSScriptRoot "project.private.config.json"),
    $privateJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
)

$configDir = Join-Path $PSScriptRoot "config"
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir | Out-Null
}

$envJs = "module.exports = {" + [Environment]::NewLine +
         "  cloudEnv: '" + $CloudEnv.Replace("'", "\'") + "'," + [Environment]::NewLine +
         "};" + [Environment]::NewLine

[System.IO.File]::WriteAllText(
    (Join-Path $configDir "env.local.js"),
    $envJs,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "[OK] Local configuration created." -ForegroundColor Green
Write-Host "  project.private.config.json -> AppID"
Write-Host "  config/env.local.js          -> Cloud ENV"
Write-Host ""
Write-Host "Both files are ignored by Git."
