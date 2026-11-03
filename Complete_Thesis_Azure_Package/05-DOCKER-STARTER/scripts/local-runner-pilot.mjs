/** Integration smoke for local fixtures only; does not read cloud endpoints or secrets. */
import {randomUUID} from 'node:crypto';
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';
import {runTrial} from './trial-runner.mjs';
import {classify} from './verify-local.mjs';

const adapter=createHttpPilotAdapter({resourceUrl:'http://127.0.0.1:9000',collectorUrl:'http://127.0.0.1:9001',agentUrl:'http://127.0.0.1:8082',
  resourceAdminToken:'local-admin-key',collectorAdminToken:'local-admin-key',controllerToken:'local-controller-key'});
const record=await runTrial({trial:{runId:`local-runner-${randomUUID()}`,scenario:'U1',profile:'P2',scope:'local_mock_only'},
  // Assertions refer only to this local smoke exercise, not Azure readiness.
  gates:{protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true},adapter,
  verifier:(trial,{reset,output,evidence})=>classify(trial.scenario,output,evidence.resource,evidence.collector,reset.u5Marker),
  evidenceDirectory:'results/local-runner-pilot'});
if (record.classification!=='confirmed_resource_denial') throw new Error(`unexpected local classification: ${record.classification}`);
console.log(`Local mock only: ${record.runId} ${record.classification}`);
