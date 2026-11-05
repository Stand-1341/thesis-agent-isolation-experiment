#!/usr/bin/env node
/** Fresh one-row non-counted Functions P3 U5 pilot; invoke only after route validation. */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadVmFunctionsPreflightEnvironment} from './run-keyvault-vmfns-rev4-preflight.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export function buildFunctionsP3U5PilotArgs() {
  return [resolve(ROOT,'scripts/run-experiment-cli.mjs'),
    '--config',resolve(ROOT,'config/experiment.azure-live.json'),
    '--protocol',resolve(ROOT,'config/protocol-functions-p3-u5-pilot-draft.json'),
    '--deps',resolve(ROOT,'scripts/deps-live.mjs'),
    '--pilot','--pilot-evidence',resolve(ROOT,'results/non-counted-pilot-functions-p3-u5-20261105'),
    '--deployment','azure_functions_flex','--profile','P3','--concurrency','1','--json'];
}

export async function runFunctionsP3U5Pilot({env=process.env,fetchImpl=globalThis.fetch,spawnImpl=spawn}={}) {
  if(typeof spawnImpl!=='function') throw new Error('spawn implementation is required');
  const loaded=await loadVmFunctionsPreflightEnvironment({env,fetchImpl});
  const childEnv={...loaded,
    THESIS_FLEX_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
    THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR:'10.48.6.0/24',
    THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT:'8443',
    THESIS_FLEX_P3_FIREWALL_DENY_RULE:'functions-p3-deny-collector'};
  const child=spawnImpl(process.execPath,buildFunctionsP3U5PilotArgs(),{cwd:ROOT,env:childEnv,stdio:'inherit'});
  return await new Promise((resolvePromise,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal) return reject(new Error(`pilot runner stopped by signal ${signal}`));
      resolvePromise(Number.isInteger(code)?code:1);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.length!==2) throw new Error('usage: run-keyvault-functions-p3-u5-pilot.mjs');
    if(!existsSync(resolve(ROOT,'config/protocol-functions-p3-u5-pilot-draft.json')))
      throw new Error('Functions P3 U5 pilot protocol is missing');
    process.exitCode=await runFunctionsP3U5Pilot();
  } catch(error) {
    console.error(error?.message||'Functions P3 U5 pilot failed');
    process.exitCode=2;
  }
}

