# Local syntax check only. It does not validate Azure routes or production trust.
param([string]$OpenSslPath = 'C:\Program Files\Git\usr\bin\openssl.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!(Test-Path -LiteralPath $OpenSslPath -PathType Leaf)) { throw 'OpenSSL is required for disposable test certificates.' }
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('thesis-proxy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $researchKey=Join-Path $scratch 'research.key'; $researchCert=Join-Path $scratch 'research.crt'
    & $OpenSslPath req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' -keyout $researchKey -out $researchCert 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Disposable certificate creation failed.' }
    Copy-Item -LiteralPath $researchKey -Destination (Join-Path $scratch 'collector.key')
    Copy-Item -LiteralPath $researchCert -Destination (Join-Path $scratch 'collector.crt')
    $template=[System.IO.File]::ReadAllText((Join-Path $projectRoot 'infra\research-proxy.nginx.template'))
    $rendered=$template.Replace('__RESEARCH_PRIVATE_IP__','127.0.0.1').Replace('__COLLECTOR_PRIVATE_IP__','127.0.0.1')
    $config=Join-Path $scratch 'default.conf'
    [System.IO.File]::WriteAllText($config,$rendered,[System.Text.UTF8Encoding]::new($false))
    docker run --rm --network none --mount "type=bind,source=$scratch,target=/etc/thesis-research/tls,readonly" --mount "type=bind,source=$config,target=/etc/nginx/conf.d/default.conf,readonly" 'nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10' nginx -t
    if ($LASTEXITCODE -ne 0) { throw 'nginx configuration validation failed.' }
} finally {
    foreach ($name in @('research.key','research.crt','collector.key','collector.crt','default.conf')) {
        $file=Join-Path $scratch $name
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
    Remove-Item -LiteralPath $scratch -Force
}
