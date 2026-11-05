#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadVmFunctionsPreflightEnvironment} from './run-keyvault-vmfns-rev4-preflight.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const env=await loadVmFunctionsPreflightEnvironment({});
const args=[resolve(root,'scripts/run-experiment-cli.mjs'),
  '--config',resolve(root,'config/experiment.azure-live.json'),
  '--protocol',resolve(root,'config/protocol-final-route-coverage-pilot-v4.json'),
  '--deps',resolve(root,'scripts/deps-live.mjs'), '--pilot',
  '--pilot-evidence',resolve(root,'results/non-counted-final-route-coverage-20261105-v4'),
  '--concurrency','1','--json'];
const child=spawn(process.execPath,args,{cwd:root,env:{...env,THESIS_AUDIT_WAIT_MS:'600000'},stdio:'inherit'});
child.once('error',error=>{console.error(error.message);process.exitCode=2;});
child.once('exit',(code,signal)=>{process.exitCode=signal?2:(code??2);});
