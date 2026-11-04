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
    Copy-Item -LiteralPath (Join-Path $projectRoot 'infra\vm-agent.service') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'infra\install-vm-agent.sh') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $destination
    Push-Location $destination
    try {
        npm ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    } finally { Pop-Location }
    $hashes = [ordered]@{}
    $relativeFiles = @('dist/agent.js','dist/core.js','dist/helpers.js','dist/network-probe.mjs','dist/azure-blob-workload.mjs','dist/azure-managed-token.mjs','dist/azure-delegated-token.mjs','dist/azure-session-seed.mjs','vm-agent.service','install-vm-agent.sh','package.json','package-lock.json')
    $dependencyFiles = Get-ChildItem -LiteralPath (Join-Path $destination 'node_modules') -Recurse -File -Force | ForEach-Object { [System.IO.Path]::GetRelativePath($destination,$_.FullName).Replace('\','/') }
    foreach ($relative in ($relativeFiles + $dependencyFiles)) {
        $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $destination $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest = [ordered]@{ scope='vm-workload-package-only'; files=$hashes; note='No credentials, Node runtime, configuration, deployment or Azure policy included.' }
    [System.IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), (($manifest | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Prepared VM workload package in $destination"
    Write-Host "Record manifest SHA-256 separately: $((Get-FileHash -LiteralPath (Join-Path $destination 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())"
    Write-Host 'No deployment or Azure configuration was performed.'
} finally { Pop-Location }
