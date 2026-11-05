param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) 'Use-ExperimentTools.ps1'
. $setupScript
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Output directory already exists; choose a new path.' }
Push-Location $projectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    New-Item -ItemType Directory -Path (Join-Path $destination 'dist') -Force | Out-Null
    $distNames = @('agent.js','core.js','helpers.js','network-probe.mjs','azure-blob-workload.mjs','azure-managed-token.mjs','azure-delegated-token.mjs','azure-session-seed.mjs')
    foreach ($name in $distNames) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "dist\$name") -Destination (Join-Path $destination 'dist')
    }
    New-Item -ItemType Directory -Path (Join-Path $destination 'certs') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'certs\thesis-pilot-ca.pem') -Destination (Join-Path $destination 'certs\thesis-pilot-ca.pem')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'infra\vm-agent.service') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'infra\install-vm-agent.sh') -Destination $destination
    foreach ($name in @('vm-agent-nginx.template','create-vm-agent-csr.sh','install-vm-agent-tls.sh')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "infra\$name") -Destination $destination
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $destination
    $hashes = [ordered]@{}
    $relativeFiles = @('dist/agent.js','dist/core.js','dist/helpers.js','dist/network-probe.mjs','dist/azure-blob-workload.mjs','dist/azure-managed-token.mjs','dist/azure-delegated-token.mjs','dist/azure-session-seed.mjs','certs/thesis-pilot-ca.pem','vm-agent.service','install-vm-agent.sh','vm-agent-nginx.template','create-vm-agent-csr.sh','install-vm-agent-tls.sh','package.json','package-lock.json')
    foreach ($relative in $relativeFiles) {
        $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $destination $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest = [ordered]@{ scope='vm-workload-package-only'; files=$hashes; note='No credentials, Node runtime, configuration, deployment or Azure policy included.' }
    [System.IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), (($manifest | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Prepared VM workload package in $destination"
    Write-Host "Record manifest SHA-256 separately: $((Get-FileHash -LiteralPath (Join-Path $destination 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())"
    Write-Host 'No deployment or Azure configuration was performed.'
} finally { Pop-Location }
