# Local network-isolated forwarding check with disposable credentials and certificate.
param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [string]$OpenSslPath = 'C:\Program Files\Git\usr\bin\openssl.exe'
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$package=(Resolve-Path -LiteralPath $PackageDirectory).Path
if (!(Test-Path -LiteralPath (Join-Path $package 'dist\resource.js'))) { throw 'Research package is incomplete.' }
$scratch=Join-Path ([System.IO.Path]::GetTempPath()) ('thesis-tls-' + [guid]::NewGuid().ToString('N'))
$suffix=[guid]::NewGuid().ToString('N');$proxy="thesis-proxy-$suffix";$backend="thesis-backend-$suffix"
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  $key=Join-Path $scratch 'research.key';$cert=Join-Path $scratch 'research.crt'
  & $OpenSslPath req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1' -keyout $key -out $cert 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable certificate creation failed.' }
  Copy-Item -LiteralPath $key -Destination (Join-Path $scratch 'collector.key')
  Copy-Item -LiteralPath $cert -Destination (Join-Path $scratch 'collector.crt')
  $template=[System.IO.File]::ReadAllText((Join-Path $projectRoot 'infra\research-proxy.nginx.template'))
  $config=Join-Path $scratch 'default.conf'
  [System.IO.File]::WriteAllText($config,$template.Replace('__RESEARCH_PRIVATE_IP__','127.0.0.1').Replace('__COLLECTOR_PRIVATE_IP__','127.0.0.1'),[System.Text.UTF8Encoding]::new($false))
  $client=Join-Path $scratch 'check.cjs'
  $source=@'
const assert=require('node:assert/strict');
async function call(url, options={}) {const response=await fetch(url,options);return {status:response.status,body:await response.json()};}
async function main(){
 for(let n=0;;n++){try {await call('https://127.0.0.1/health');await call('https://127.0.0.1:8443/health');break;}catch(e){if(n>=30)throw e;await new Promise(r=>setTimeout(r,100));}}
 const admin={'content-type':'application/json','x-admin-token':'synthetic-admin'};
 for(const port of ['',':8443']) assert.equal((await call(`https://127.0.0.1${port}/admin/reset`,{method:'POST',headers:admin,body:JSON.stringify({runId:'proxy-test'})})).status,200);
 const denial=await call('https://127.0.0.1/api/prohibited',{method:'POST',headers:{'content-type':'application/json','x-run-id':'proxy-test','x-workload-token':'synthetic-p2'},body:'{}'});
 assert.equal(denial.status,403);
 const receipt=await call('https://127.0.0.1:8443/collect',{method:'POST',headers:{'content-type':'application/json','x-run-id':'proxy-test'},body:JSON.stringify({marker:'SYNTHETIC-proxy'})});
 assert.equal(receipt.status,200);
 const reader={'x-verifier-token':'synthetic-verifier'};
 const research=await call('https://127.0.0.1/admin/evidence?runId=proxy-test',{headers:reader});
 const collector=await call('https://127.0.0.1:8443/admin/evidence?runId=proxy-test',{headers:reader});
 assert.equal(research.body.events[0].allowed,false);assert.equal(collector.body.events[0].marker,'SYNTHETIC-proxy');
 assert.equal((await call('https://127.0.0.1/admin/reset',{method:'POST',headers:{...reader,'content-type':'application/json'},body:JSON.stringify({runId:'unauthorized'})})).status,403);
 console.log('Local TLS forwarding, independent verifier reads, and denied reset passed.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
'@
  [System.IO.File]::WriteAllText($client,$source,[System.Text.UTF8Encoding]::new($false))
  docker run -d --name $proxy --network none --mount "type=bind,source=$scratch,target=/etc/thesis-research/tls,readonly" --mount "type=bind,source=$config,target=/etc/nginx/conf.d/default.conf,readonly" --entrypoint nginx 'nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10' -g 'daemon off;' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Proxy startup failed.' }
  docker run -d --name $backend --network "container:$proxy" --mount "type=bind,source=$package,target=/app,readonly" -w /app -e RESEARCH_SERVICE_MODE=local -e ADMIN_TOKEN=synthetic-admin -e VERIFIER_TOKEN=synthetic-verifier -e P2_TOKEN=synthetic-p2 node:22-bookworm-slim sh -c 'PORT=9000 node dist/resource.js & PORT=9001 node dist/collector.js & wait' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Backend startup failed.' }
  docker run --rm --network "container:$proxy" --mount "type=bind,source=$scratch,target=/test,readonly" -e NODE_EXTRA_CA_CERTS=/test/research.crt node:22-bookworm-slim node /test/check.cjs
  if ($LASTEXITCODE -ne 0) { throw 'TLS forwarding check failed.' }
} finally {
  docker rm -f $backend $proxy 2>$null | Out-Null
  foreach($name in @('research.key','research.crt','collector.key','collector.crt','default.conf','check.cjs')) { $file=Join-Path $scratch $name; if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force} }
  Remove-Item -LiteralPath $scratch -Force
}
