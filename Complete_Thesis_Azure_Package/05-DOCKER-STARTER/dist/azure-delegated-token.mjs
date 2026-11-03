/** Preliminary shape checks only. Azure Storage must authenticate the token. */
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateClaims({token,expectedPrincipalId,expectedAudience,nowMs=Date.now(),maxLifetimeSeconds=7200}) {
  if(typeof token!=='string' || token.length<100 || token.length>16000 || !guid.test(expectedPrincipalId || '') ||
    !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds<60 || maxLifetimeSeconds>172800) throw new Error('invalid scoped token');
  const parts=token.split('.');
  if(parts.length!==3 || !parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('invalid scoped token');
  let claims; try {claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));} catch {throw new Error('invalid scoped token');}
  const now=Math.floor(nowMs/1000);
  if(claims.aud!==expectedAudience || typeof claims.oid!=='string' || claims.oid.toLowerCase()!==expectedPrincipalId.toLowerCase() ||
    !Number.isSafeInteger(claims.exp) || claims.exp<now+30 || claims.exp>now+maxLifetimeSeconds ||
    (claims.nbf!==undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf>now+60))) throw new Error('scoped token claims do not match expected identity and audience');
  return token;
}
export function createDelegatedStorageTokenProvider(options) {
  const token=validateClaims({...options,expectedAudience:'https://storage.azure.com/'});
  return async()=>token;
}
export function validateSessionControlToken(options) {
  validateClaims({...options,maxLifetimeSeconds:90000,expectedAudience:'https://dynamicsessions.io'});
}
