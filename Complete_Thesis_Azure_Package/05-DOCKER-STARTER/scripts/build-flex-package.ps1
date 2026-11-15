param([Parameter(Mandatory=$true)][string]$OutputDirectory,[Parameter(Mandatory=$true)][string]$CaCertificatePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1'
. $setupScript
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Output directory already exists; choose a new path.' }
$caPath = (Resolve-Path -LiteralPath $CaCertificatePath).Path
$caItem = Get-Item -LiteralPath $caPath -Force
if ($caItem.PSIsContainer -or ($caItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'CA input must be a regular, non-link public certificate file.' }
$caText = [System.IO.File]::ReadAllText($caPath)
if ($caText -notmatch '-----BEGIN CERTIFICATE-----' -or $caText -match 'PRIVATE KEY') { throw 'CA input must contain public certificate PEM only.' }
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
    Copy-Item -LiteralPath $caPath -Destination (Join-Path $destination 'certs\thesis-pilot-ca.pem')
    Push-Location $destination
    try {
        npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Functions dependency installation failed.' }
    } finally { Pop-Location }
    Write-Host "Prepared Functions source package in $destination"
    Write-Host 'No deployment or Azure configuration was performed.'
} finally { Pop-Location }
