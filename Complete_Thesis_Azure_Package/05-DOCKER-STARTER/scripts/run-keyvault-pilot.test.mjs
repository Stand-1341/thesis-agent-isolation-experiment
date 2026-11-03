import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPilotArgs,loadPilotEnvironment, PILOT_SECRET_MAP} from './run-keyvault-pilot.mjs';

const token='test-access-token';
const secretValue=name=>`value-for-${name}-012345678901234567890123`;

test('pilot launcher reads only its fixed Key Vault secret names and maps them into child environment',async()=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{
    requests.push({url:String(url),options});
    if(String(url).startsWith('http://169.254.169.254/'))
      return new Response(JSON.stringify({access_token:token}),{status:200});
    const name=decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1));
    return new Response(JSON.stringify({value:secretValue(name)}),{status:200});
  };
  const env=await loadPilotEnvironment({env:{KEEP_ME:'yes'},fetchImpl});
  assert.equal(env.KEEP_ME,'yes');
  assert.equal(env.THESIS_TOKEN_PROVIDER_MODE,'managed_identity');
  assert.equal(requests.length,1+PILOT_SECRET_MAP.length);
  assert.equal(requests[0].options.headers.Metadata,'true');
  for(const [name,target] of PILOT_SECRET_MAP) {
    assert.equal(env[target],secretValue(name));
    assert.ok(requests.some(request=>request.url.includes(`/secrets/${name}?`)));
  }
  assert.equal(requests[1].options.headers.authorization,`Bearer ${token}`);
});

test('pilot launcher fails closed when Key Vault secret is missing and does not expose response body',async()=>{
  let call=0;
  const fetchImpl=async()=>{
    call++;
    if(call===1) return new Response(JSON.stringify({access_token:token}),{status:200});
    return new Response('sensitive detail',{status:404});
  };
  await assert.rejects(loadPilotEnvironment({env:{},fetchImpl}),error=>{
    assert.match(error.message,/functions-p1-controller-key/);
    assert.doesNotMatch(error.message,/sensitive detail|access-token/);
    return true;
  });
});

test('pilot launcher rejects short Key Vault credentials before spawning the runner',async()=>{
  let call=0;
  const fetchImpl=async()=>{
    call++;
    if(call===1) return new Response(JSON.stringify({access_token:token}),{status:200});
    return new Response(JSON.stringify({value:'too-short'}),{status:200});
  };
  await assert.rejects(loadPilotEnvironment({env:{},fetchImpl}),/invalid: functions-p1-controller-key/);
  assert.equal(call,2);
});

test('pilot launcher fixes config, deployment, profile, one-at-a-time execution, and limits scope',()=>{
  assert.deepEqual(buildPilotArgs([]),[
    'scripts/run-experiment-cli.mjs','--config','config/experiment.pilot.functions-p1.example.json',
    '--pilot','--deployment','azure_functions_flex','--profile','P1','--concurrency','1','--deps','scripts/deps-live.mjs'
  ]);
  assert.ok(buildPilotArgs(['--limit','1']).includes('1'));
  for(const args of [
    ['--gates','protocolFrozen'],['--config','other.json'],['--deployment','azure_vm'],
    ['--profile','P3'],['--pilot'],['--deps','fake.mjs'],['--limit','11'],['--limit','0'],['--help']
  ]) assert.throws(()=>buildPilotArgs(args));
});
