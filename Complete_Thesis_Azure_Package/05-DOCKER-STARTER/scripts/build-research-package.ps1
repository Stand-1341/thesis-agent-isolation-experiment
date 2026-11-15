param([Parameter(Mandatory=$true)][string]$OutputDirectory,[Parameter(Mandatory=$true)][string]$CaCertificatePath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1')
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Output directory already exists; choose a new path.' }
$caPath = (Resolve-Path -LiteralPath $CaCertificatePath).Path
$caItem = Get-Item -LiteralPath $caPath -Force
if ($caItem.PSIsContainer -or ($caItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'CA input must be a regular, non-link public certificate file.' }
$caText = [System.IO.File]::ReadAllText($caPath)
if ($caText -notmatch '-----BEGIN CERTIFICATE-----' -or $caText -match 'PRIVATE KEY') { throw 'CA input must contain public certificate PEM only.' }
Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    New-Item -ItemType Directory -Path (Join-Path $destination 'dist') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $destination 'infra') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $destination 'certs') -Force | Out-Null
    Copy-Item -LiteralPath $caPath -Destination (Join-Path $destination 'certs\thesis-pilot-ca.pem')
    $distNames = @('resource.js','collector.js','resource-journal.js','collector-journal.js','service-config.js','helpers.js')
    foreach ($name in $distNames) { Copy-Item -LiteralPath (Join-Path $projectRoot "dist\$name") -Destination (Join-Path $destination 'dist') }
    $hostSupportScripts = @('install-three-arm-service-secrets.mjs','install-research-host-ca-key.mjs','bootstrap-research-host-tls.sh','renew-research-host-tls.sh','stage-research-host.sh')
    foreach ($name in $hostSupportScripts) { Copy-Item -LiteralPath (Join-Path $projectRoot "infra\$name") -Destination (Join-Path $destination 'infra') }
    foreach ($name in @('research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "infra\$name") -Destination $destination
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $destination
    $files = @($distNames | ForEach-Object { "dist/$_" }) + @($hostSupportScripts | ForEach-Object { "infra/$_" }) + @('certs/thesis-pilot-ca.pem','research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh','package.json')
    $hashes = [ordered]@{}
    foreach ($relative in $files) { $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $destination $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
    $manifest = [ordered]@{ scope='research-service-package-only'; files=$hashes; note='Includes root-only host TLS bootstrap/renewal and secret-delivery code; no credentials, TLS keys, runtime, deployment, identity attachment or Azure role assignments included.' }
    [System.IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), (($manifest | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Prepared research service package in $destination"
    Write-Host "Record manifest SHA-256 separately: $((Get-FileHash -LiteralPath (Join-Path $destination 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally { Pop-Location }
