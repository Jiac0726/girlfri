$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repoRoot 'scripts/database-common.ps1')

$innerJson = '{"update":"couples","updates":[{"q":{"_id":"pair_1","status":{"$ne":"waiting"}},"u":{"$set":{"inviteCode":"USED_pair_1"}},"multi":false}]}'
$commandsJson = ConvertTo-TcbMgoCommandsJson -CommandJson $innerJson
$outer = ConvertFrom-Json $commandsJson

if ($outer.Count -ne 1) { throw 'Expected one MgoCommandParam.' }
if ($outer[0].TableName -ne 'couples') { throw 'Expected TableName=couples.' }
if ($outer[0].CommandType -ne 'UPDATE') { throw 'Expected CommandType=UPDATE.' }
if ($outer[0].Command -ne $innerJson) { throw 'Inner Command JSON changed unexpectedly.' }

$queryJson = ConvertTo-TcbMgoCommandsJson -CommandJson '{"find":"couples","filter":{},"limit":1}'
$query = ConvertFrom-Json $queryJson
if ($query[0].TableName -ne 'couples') { throw 'find collection mapping failed.' }
if ($query[0].CommandType -ne 'QUERY') { throw 'find should map to QUERY.' }

$indexJson = ConvertTo-TcbMgoCommandsJson -CommandJson '{"createIndexes":"couples","indexes":[{"key":{"inviteCode":1},"name":"idx_inviteCode_unique","unique":true}]}'
$index = ConvertFrom-Json $indexJson
if ($index[0].TableName -ne 'couples') { throw 'createIndexes collection mapping failed.' }
if ($index[0].CommandType -ne 'COMMAND') { throw 'createIndexes should map to COMMAND.' }

$tempDir = Join-Path $env:TEMP ('renian-native-argv-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    $fakeCli = Join-Path $tempDir 'fake-cli.js'
    $argsFile = Join-Path $tempDir 'args.json'
    $bridge = Join-Path $repoRoot 'scripts/tcb-argv-bridge.js'

    [System.IO.File]::WriteAllText(
        $fakeCli,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
        (New-Object System.Text.UTF8Encoding($false))
    )

    $expectedArgs = @(
        'db', 'nosql', 'execute',
        '--command', $commandsJson,
        '--env-id', 'fixture-env',
        '--json'
    )

    [System.IO.File]::WriteAllText(
        $argsFile,
        (ConvertTo-Json -InputObject $expectedArgs -Compress),
        (New-Object System.Text.UTF8Encoding($false))
    )

    $receivedText = & node.exe $bridge $fakeCli $argsFile
    if ($LASTEXITCODE -ne 0) {
        throw "Node argv bridge failed with exit code $LASTEXITCODE"
    }

    $receivedArgs = ConvertFrom-Json ([string]$receivedText)
    if ($receivedArgs.Count -ne $expectedArgs.Count) {
        throw 'Bridge changed argv count.'
    }

    for ($i = 0; $i -lt $expectedArgs.Count; $i++) {
        if ([string]$receivedArgs[$i] -ne [string]$expectedArgs[$i]) {
            throw ("Bridge changed argv at index " + $i)
        }
    }

    $receivedOuter = ConvertFrom-Json ([string]$receivedArgs[4])
    if ($receivedOuter[0].Command -ne $innerJson) {
        throw 'Nested Command JSON did not survive bridge argv transport.'
    }

    Write-Host ('MgoCommandParam + Node argv bridge test passed on PowerShell ' + $PSVersionTable.PSVersion)
}
finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
