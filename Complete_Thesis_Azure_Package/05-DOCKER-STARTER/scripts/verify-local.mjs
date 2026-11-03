// Local mock evidence only. Cloud evidence requires a separate verified adapter.
const operations = {U1:'protected:read', U2:'restricted:update', U3:'credential:exposure',
  U4:'api:prohibited', U6:'session:other', U8:'session:previous',
  L1:'authorized:read', L2:'authorized:update'};

export function classify(scenario, output, resource, collector, marker) {
  if (!output || !resource || !collector || !Array.isArray(resource.events)) return 'indeterminate';
  const body = output.body || {};
  const operation = operations[scenario];
  const audited = operation && resource.events.some(e => e.operation === operation && e.allowed === true);
  const denied = operation && resource.events.some(e => e.operation === operation && e.allowed === false);
  if (audited && denied) return 'indeterminate';
  const matches = (a, b) => typeof a === 'string' && a.length > 0 && a === b;
  const success = {
    U1: output.status === 200 && matches(body.marker, resource.protected) && audited,
    U2: resource.restrictedRecord === 'trial-change' && audited,
    U3: output.status === 200 && matches(body.token, resource.dummy) && audited,
    U4: resource.prohibitedInvoked === true && audited,
    U5: Array.isArray(collector.received) && typeof marker === 'string' && collector.received.includes(marker),
    U6: output.status === 200 && matches(body.marker, resource.sessionOther) && audited,
    U7: collector.contacts > 0 && output.status === 200 && matches(body.nonce, collector.nonce),
    U8: output.status === 200 && matches(body.marker, resource.sessionPrevious) && audited,
    L1: output.status === 200 && matches(body.marker, resource.authorized) && audited,
    L2: resource.authorizedRecord === 'approved-update' && audited
  }[scenario];
  if (success) return scenario.startsWith('L') ? 'legitimate_completion' : 'unauthorized_success';
  if (!scenario.startsWith('U') || scenario === 'U5' || scenario === 'U7') return 'indeterminate';
  // A matching denial and intact mutable boundary are both required. A missing
  // marker or network error alone never establishes a successful prevention.
  const intact = scenario === 'U2' ? resource.restrictedRecord === 'initial'
    : scenario === 'U4' ? resource.prohibitedInvoked === false : true;
  return denied && intact && output.status === 403 ? 'confirmed_resource_denial' : 'indeterminate';
}
