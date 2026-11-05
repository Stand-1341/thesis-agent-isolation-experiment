import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildFunctionsP3U5PilotArgs,runFunctionsP3U5Pilot} from './run-keyvault-functions-p3-u5-pilot.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('Functions P3 U5 pilot binds its unique one-row schedule and separate non-counted evidence path',async()=>{
  const args=buildFunctionsP3U5PilotArgs();
  assert.ok(args.includes(resolve(ROOT,'config/protocol-functions-p3-u5-pilot-draft.json')));
  assert.ok(args.includes(resolve(ROOT,'scripts/deps-live.mjs')));
  assert.ok(args.includes('--pilot'));
  assert.ok(args.includes(resolve(ROOT,'results/non-counted-pilot-functions-p3-u5-20261105')));
  assert.ok(args.includes('--deployment')&&args.includes('azure_functions_flex'));
  assert.ok(args.includes('--profile')&&args.includes('P3'));
  const protocol=JSON.parse(await readFile(resolve(ROOT,'config/protocol-functions-p3-u5-pilot-draft.json'),'utf8'));
  const schedule=await readFile(resolve(ROOT,'..',protocol.pilotPlan.file));
  assert.equal(createHash('sha256').update(schedule).digest('hex'),protocol.pilotPlan.sha256);
  assert.equal(protocol.pilotPlan.trials,1);
  assert.equal(protocol.pilotPlan.countedAsStudyTrials,false);
  assert.equal(protocol.pilotPlan.runId,'pilot-functions-p3-u5-20261105a');
});

test('U5 runner injects only the configured denial reader inputs and does not assert readiness gates',async()=>{
  let childArgs,childEnv;
  const fetchImpl=async url=>({ok:true,status:200,json:async()=>
    String(url).includes('169.254.169.254')?{access_token:'mock-managed-identity-token'}:{value:'mock-key-v-'+'x'.repeat(40)}});
  const spawnImpl=(_node,args,options)=>{
    childArgs=args;
    childEnv=options.env;
    const child=new EventEmitter();
    setImmediate(()=>child.emit('exit',0,null));
    return child;
  };
  assert.equal(await runFunctionsP3U5Pilot({env:{},fetchImpl,spawnImpl}),0);
  assert.equal(childArgs.includes('--pilot'),true);
  assert.equal(childEnv.THESIS_FLEX_P3_DENIAL_TELEMETRY,'azure_diagnostics_firewall');
  assert.equal(childEnv.THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR,'10.48.6.0/24');
  assert.equal(childEnv.THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT,'8443');
  assert.equal(childEnv.THESIS_FLEX_P3_FIREWALL_DENY_RULE,'functions-p3-deny-collector');
  for(const name of ['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
    'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
    'THESIS_DENIAL_STATUS_TEXT_VALIDATED']) assert.equal(childEnv[name],undefined);
});
