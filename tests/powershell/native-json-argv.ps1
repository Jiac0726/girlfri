$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts/database-common.ps1')

$json = '{"update":"couples","updates":[{"q":{"_id":"pair_1","status":{"$ne":"waiting"}},"u":{"$set":{"inviteCode":"USED_pair_1"}},"multi":false}]}'
$nativeArg = ConvertTo-TcbJsonArgument -Json $json

$tempJs = Join-Path $env:TEMP ('renian-native-argv-' + [Guid]::NewGuid().ToString('N') + '.js')
try {
    [System.IO.File]::WriteAllText(
        $tempJs,
        'process.stdout.write(process.argv[2]);',
        (New-Object System.Text.UTF8Encoding($false))
    )

    $received = & node.exe $tempJs $nativeArg
    if ($LASTEXITCODE -ne 0) {
        throw "node.exe argv probe failed with exit code $LASTEXITCODE"
    }

    if ([string]$received -ne $json) {
        throw ("Native argv JSON mismatch." + [Environment]::NewLine + "Expected: " + $json + [Environment]::NewLine + "Received: " + [string]$received)
    }

    $received | ConvertFrom-Json | Out-Null
    Write-Host ('Native JSON argv compatibility test passed on PowerShell ' + $PSVersionTable.PSVersion)
}
finally {
    Remove-Item $tempJs -Force -ErrorAction SilentlyContinue
}
