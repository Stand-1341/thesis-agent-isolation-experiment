#!/usr/bin/env node
/** Run the explicitly authorized one-row non-counted Central VM P3 U5 pilot. */
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSelectedVmCredentials} from './run-keyvault-measured-preflight.mjs';

if(process.argv.length!==2) {
  console.error('usage: run-keyvault-central-p3-u5-pilot.mjs');
  process.exit(5);
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ca=process.env.THESIS_NODE_EXTRA_CA_CERTS||'/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem';
const env=await loadSelectedVmCredentials({profile:'P3',env:{...process.env,THESIS_NODE_EXTRA_CA_CERTS:ca,
  THESIS_VM_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
  THESIS_VM_P3_FIREWALL_SOURCE_IP:'10.49.8.4',
  THESIS_DENIAL_DESTINATION_IP:'10.48.9.5',
  THESIS_VM_P3_FIREWALL_DESTINATION_PORT:'8443',
  THESIS_VM_P3_FIREWALL_DENY_RULE:'deny-centralus-p3-collector',
  THESIS_AUDIT_WAIT_MS:'600000'}});
const args=[resolve(root,'scripts/run-experiment-cli.mjs'),
  '--config',resolve(root,'config/experiment.azure-live.json'),
  '--protocol',resolve(root,'config/protocol-400-rev4-vm-functions-draft.json'),
  '--deps',resolve(root,'scripts/deps-live.mjs'),
  '--pilot','--pilot-evidence',resolve(root,'results/non-counted-pilot-central-vm-p3-u5-20261105'),
  '--deployment','azure_vm','--profile','P3','--concurrency','1','--json'];
const child=spawn(process.execPath,args,{cwd:root,env:{...env,NODE_EXTRA_CA_CERTS:ca},stdio:'inherit'});
child.once('error',error=>{console.error(`Central P3 pilot start failed: ${error.message}`);process.exitCode=4;});
child.once('exit',(code,signal)=>{process.exitCode=signal?2:(Number.isInteger(code)?code:1);});
