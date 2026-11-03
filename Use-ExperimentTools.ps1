# Dot-source this file in PowerShell to select the project's Node 22 runtime.
# .tools/ is gitignored, so a fresh clone has no bundled runtime. Fall back to a
# Node 22 already on PATH, and only fail if there is no usable Node 22 at all.
$experimentNodePath = Join-Path $PSScriptRoot '.tools\node-official\node-v22.23.4-win-x64'
if (Test-Path -LiteralPath (Join-Path $experimentNodePath 'node.exe')) {
    $env:PATH = "$experimentNodePath;$env:PATH"
} else {
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if (-not $systemNode) {
        throw "No Node runtime found. Either install Node 22, or place the official Windows build at $experimentNodePath (download node-v22.23.4-win-x64.zip from https://nodejs.org/dist/v22.23.4/ and extract it there)."
    }
    $systemVersion = (& node --version) -replace '^v',''
    if (-not $systemVersion.StartsWith('22.')) {
        Write-Warning "Using Node $systemVersion from PATH; this project is validated on Node 22."
    }
}
$experimentAzurePath = Join-Path $PSScriptRoot '.tools\azure-cli\bin'
if (Test-Path -LiteralPath (Join-Path $experimentAzurePath 'az.cmd')) {
    $env:PATH = "$experimentAzurePath;$env:PATH"
}
Write-Host "Experiment Node: $(& node --version); npm: $(& npm --version)"
