param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1'
. $setupScript
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Output directory already exists; choose a new path.' }
Push-Location $projectRoot
try {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    New-Item -ItemType Directory -Path $destination | Out-Null
    foreach ($name in @('host.json','index.mjs','prepare-run-request.mjs','package.json','package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "functions\$name") -Destination $destination
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $destination -Recurse
    New-Item -ItemType Directory -Path (Join-Path $destination 'certs') | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'certs\thesis-pilot-ca.pem') -Destination (Join-Path $destination 'certs\thesis-pilot-ca.pem')
    Push-Location $destination
    try {
        npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Functions dependency installation failed.' }
    } finally { Pop-Location }
    Write-Host "Prepared Functions source package in $destination"
    Write-Host 'No deployment or Azure configuration was performed.'
} finally { Pop-Location }
