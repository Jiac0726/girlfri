$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts/database-common.ps1')

$innerJson = '{"update":"couples","updates":[{"q":{"_id":"pair_1","status":{"$ne":"waiting"}},"u":{"$set":{"inviteCode":"USED_pair_1"}},"multi":false}]}'
$mgoJson = ConvertTo-MgoCommandsJson -CommandJson $innerJson
$nativeArg = ConvertTo-TcbJsonArgument -Json $mgoJson

$tempJs = Join-Path $env:TEMP ('renian-native-argv-' + [Guid]::NewGuid().ToString('N') + '.js')
try {
    [System.IO.File]::WriteAllText(
        $tempJs,
        'const x=process.argv[2]; const p=JSON.parse(x); if(!Array.isArray(p)) process.exit(21); if(p.length!==1) process.exit(22); if(p[0].TableName!=="couples") process.exit(23); if(p[0].CommandType!=="UPDATE") process.exit(24); if(p[0].Command!==process.env.EXPECTED_INNER) process.exit(25); process.stdout.write(x);',
        (New-Object System.Text.UTF8Encoding($false))
    )

    $env:EXPECTED_INNER = $innerJson
    $received = & node.exe $tempJs $nativeArg
    $code = $LASTEXITCODE
    Remove-Item Env:EXPECTED_INNER -ErrorAction SilentlyContinue

    if ($code -ne 0) {
        throw "node.exe MgoCommands argv probe failed with exit code $code"
    }

    if ([string]$received -ne $mgoJson) {
        throw ("Native argv JSON mismatch." + [Environment]::NewLine + "Expected: " + $mgoJson + [Environment]::NewLine + "Received: " + [string]$received)
    }

    $query = ConvertTo-MgoCommandsJson -CommandJson '{"find":"couples","limit":1}'
    $queryParsed = ConvertFrom-Json $query
    if ($queryParsed[0].CommandType -ne 'QUERY') { throw 'find should map to QUERY.' }
    if ($queryParsed[0].TableName -ne 'couples') { throw 'find should map collection name.' }

    Write-Host ('MgoCommands native JSON argv compatibility test passed on PowerShell ' + $PSVersionTable.PSVersion)
}
finally {
    Remove-Item Env:EXPECTED_INNER -ErrorAction SilentlyContinue
    Remove-Item $tempJs -Force -ErrorAction SilentlyContinue
}
