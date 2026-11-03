import {loadPilotEnvironment} from './run-keyvault-pilot.mjs';

const checks=[
  ['research', 'https://10.48.9.4/admin/evidence', 'THESIS_RESOURCE_ADMIN_KEY'],
  ['collector', 'https://10.48.9.5:8443/admin/evidence', 'THESIS_COLLECTOR_ADMIN_KEY']
];

try {
  const env=await loadPilotEnvironment();
  const runId=`credential-check-${Date.now()}`;
  for(const [label,endpoint,keyName] of checks) {
    try {
      const url=new URL(endpoint);
      url.searchParams.set('runId',runId);
      const response=await fetch(url,{method:'GET',redirect:'error',
        headers:{'x-admin-token':env[keyName]},signal:AbortSignal.timeout(15000)});
      const result=response.status===403?'rejected':([200,404].includes(response.status)?'accepted':`unexpected HTTP ${response.status}`);
      process.stdout.write(`${label} admin credential: ${result}\n`);
    } catch(error) {
      process.stdout.write(`${label} admin credential: request failed (${error?.name==='TimeoutError'?'timeout':'network/TLS error'})\n`);
    }
  }
} catch(error) {
  process.stderr.write(`credential check could not start: ${error?.message||'setup error'}\n`);
  process.exitCode=2;
}
