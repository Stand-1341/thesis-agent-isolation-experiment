// Controller-side evidence storage. Keep this directory inaccessible to workloads.
import {createHash} from 'node:crypto';
import {mkdir, open, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
function checkedId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw new Error('invalid evidence run ID');
  return id;
}
export function encodeEvidence(record) {
  checkedId(record?.runId);
  const payload=JSON.stringify(record);
  return JSON.stringify({version:1,sha256:digest(payload),payload})+'\n';
}
export function decodeEvidence(text) {
  const envelope=JSON.parse(text);
  if(envelope.version!==1 || typeof envelope.payload!=='string' || digest(envelope.payload)!==envelope.sha256)
    throw new Error('evidence integrity check failed');
  const record=JSON.parse(envelope.payload);
  checkedId(record.runId);
  return record;
}
export async function saveEvidence(directory, record) {
  const id=checkedId(record?.runId);
  const envelope=encodeEvidence(record);
  await mkdir(directory,{recursive:true});
  const path=join(directory,`${id}.json`);
  // Exclusive creation ensures retries cannot overwrite an existing observation.
  const file=await open(path,'wx',0o600);
  try { await file.writeFile(envelope,'utf8'); await file.sync(); }
  finally { await file.close(); }
  return path;
}
export async function readEvidence(path) {
  return decodeEvidence(await readFile(path,'utf8'));
}
