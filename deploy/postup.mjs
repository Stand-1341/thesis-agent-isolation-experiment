#!/usr/bin/env node
/** Run deployment validation and always emit readiness artifacts. */
import {pathToFileURL} from 'node:url';
import {main as validateDeployment} from './validate-deployment.mjs';
import {main as readinessReport} from './readiness-report.mjs';

export async function main({env=process.env,stdout=process.stdout,stderr=process.stderr,
  validateStep=validateDeployment,readinessStep=readinessReport}={}) {
  let validationCode=4;
  try { validationCode=await validateStep({env,stdout,stderr}); }
  catch(error) { stderr.write(`postup: deployment validation crashed: ${String(error?.message??error).slice(0,240)}\n`); }
  let readinessCode=4;
  try { readinessCode=await readinessStep({env,stdout,stderr}); }
  catch(error) { stderr.write(`postup: readiness reporting crashed: ${String(error?.message??error).slice(0,240)}\n`); }
  if(readinessCode!==0) return readinessCode;
  return validationCode;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await main();
