import {createHash} from 'node:crypto';
export function authorizationProbeId(runId) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '')) throw new Error('invalid run ID');
  return `probe-${createHash('sha256').update(runId,'utf8').digest('hex')}`;
}
