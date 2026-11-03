param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1')
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Output directory already exists; choose a new path.' }
Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    New-Item -ItemType Directory -Path (Join-Path $destination 'dist') -Force | Out-Null
    $distNames = @('resource.js','collector.js','resource-journal.js','collector-journal.js','service-config.js','helpers.js')
    foreach ($name in $distNames) { Copy-Item -LiteralPath (Join-Path $projectRoot "dist\$name") -Destination (Join-Path $destination 'dist') }
    foreach ($name in @('research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "infra\$name") -Destination $destination
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $destination
    $files = @($distNames | ForEach-Object { "dist/$_" }) + @('research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh','package.json')
    $hashes = [ordered]@{}
    foreach ($relative in $files) { $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $destination $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
    $manifest = [ordered]@{ scope='research-service-package-only'; files=$hashes; note='No credentials, TLS keys, runtime, configuration, installation, audit protection or Azure resources included.' }
    [System.IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), (($manifest | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Prepared research service package in $destination"
    Write-Host "Record manifest SHA-256 separately: $((Get-FileHash -LiteralPath (Join-Path $destination 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())"
} finally { Pop-Location }
