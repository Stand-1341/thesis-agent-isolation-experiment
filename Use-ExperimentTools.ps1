# Dot-source this file in PowerShell to select the project's Node 22 runtime.
$experimentNodePath = Join-Path $PSScriptRoot '.tools\node-official\node-v22.23.4-win-x64'
if (-not (Test-Path -LiteralPath (Join-Path $experimentNodePath 'node.exe'))) {
    throw 'The project Node 22 runtime is missing.'
}
$env:PATH = "$experimentNodePath;$env:PATH"
$experimentAzurePath = Join-Path $PSScriptRoot '.tools\azure-cli\bin'
if (Test-Path -LiteralPath (Join-Path $experimentAzurePath 'az.cmd')) {
    $env:PATH = "$experimentAzurePath;$env:PATH"
}
Write-Host "Experiment Node: $(& node --version); npm: $(& npm --version)"
