import {loadPilotEnvironment} from './run-keyvault-pilot.mjs';

const checks=[
  ['research admin','https://10.48.9.4/admin/evidence','x-admin-token','THESIS_RESOURCE_ADMIN_KEY'],
  ['collector admin','https://10.48.9.5:8443/admin/evidence','x-admin-token','THESIS_COLLECTOR_ADMIN_KEY'],
  ['research verifier','https://10.48.9.4/admin/evidence','x-verifier-token','THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY'],
  ['collector verifier','https://10.48.9.5:8443/admin/evidence','x-verifier-token','THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY']
];

try {
  const env=await loadPilotEnvironment();
  const runId=`credential-check-${Date.now()}`;
  for(const [label,endpoint,header,keyName] of checks) {
    try {
      const url=new URL(endpoint);
      url.searchParams.set('runId',runId);
      const response=await fetch(url,{method:'GET',redirect:'error',
        headers:{[header]:env[keyName]},signal:AbortSignal.timeout(15000)});
      const result=response.status===403?'rejected':([200,404].includes(response.status)?'accepted':`unexpected HTTP ${response.status}`);
      process.stdout.write(`${label} credential: ${result}\n`);
    } catch(error) {
      process.stdout.write(`${label} credential: request failed (${error?.name==='TimeoutError'?'timeout':'network/TLS error'})\n`);
    }
  }
} catch(error) {
  process.stderr.write(`credential check could not start: ${error?.message||'setup error'}\n`);
  process.exitCode=2;
}
