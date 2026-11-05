#!/usr/bin/env node
/** Run only the two fresh, non-counted rows in retry-v1 using controller Key Vault credentials. */
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSelectedVmCredentials} from './run-keyvault-measured-preflight.mjs';

const argv=process.argv.slice(2);
if(argv.length!==2||argv[0]!=='--profile'||!['P1','P2'].includes(argv[1])) {
  console.error('usage: run-keyvault-rev4-vm-pilot-retry-v1.mjs --profile P1|P2');
  process.exit(5);
}
const profile=argv[1],root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ca=process.env.THESIS_NODE_EXTRA_CA_CERTS||'/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem';
const env=await loadSelectedVmCredentials({profile,env:{...process.env,THESIS_NODE_EXTRA_CA_CERTS:ca}});
const args=[resolve(root,'scripts/run-experiment-cli.mjs'),
  '--config',resolve(root,'config/experiment.rev4-vm-p1-p2-pilot.json'),
  '--protocol',resolve(root,'config/protocol-400-rev4-vm-p1-p2-pilot-retry-v1.json'),
  '--deps',resolve(root,'scripts/deps-live.mjs'),
  '--pilot','--pilot-evidence',resolve(root,'results/non-counted-pilot-rev4-vm-p1-p2-retry-v1-20261105'),
  '--deployment','azure_vm','--profile',profile,'--concurrency','1','--json'];
const child=spawn(process.execPath,args,{cwd:root,env:{...env,NODE_EXTRA_CA_CERTS:ca},stdio:'inherit'});
child.once('error',error=>{console.error(`pilot retry runner start failed: ${error.message}`);process.exitCode=4;});
child.once('exit',(code,signal)=>{process.exitCode=signal?2:(Number.isInteger(code)?code:1);});
