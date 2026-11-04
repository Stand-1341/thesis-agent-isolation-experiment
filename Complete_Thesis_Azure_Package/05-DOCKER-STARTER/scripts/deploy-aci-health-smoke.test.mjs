import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const script = await readFile(new URL('../infra/deploy-aci-health-smoke.ps1', import.meta.url), 'utf8');
const groupTemplate = await readFile(new URL('../infra/aci-agent-group-pilot.bicep', import.meta.url), 'utf8');

test('ACI health smoke is isolated to a private, digest-pinned non-trial group', () => {
  assert.match(script, /ValidatePattern/);
  assert.match(script, /@sha256:\[a-fA-F0-9\]\{64\}/);
  assert.match(script, /StartsWith\("\$RegistryServer\//);
  assert.match(groupTemplate, /type: 'Private'/);
  assert.match(groupTemplate, /AZURE_PRINCIPAL_OBJECT_ID/);
  assert.match(groupTemplate, /THESIS_BLOB_RESOURCE_ID/);
  assert.match(script, /workloadPrincipalObjectId = \@\{ value = \$workloadIdentity\.principalId \}/);
  assert.match(script, /blobResourceId = \@\{ value = \$dummyBlobResourceId \}/);
  assert.match(groupTemplate, /restartPolicy: 'Never'/);
  assert.match(script, /trials=0/);
  assert.doesNotMatch(script, /\/run(?:\b|['"])/i);
  assert.doesNotMatch(script, /trial-runner|run-experiment-cli|functions\/api\/run/i);
});

test('smoke injects random disposable credentials through a protected temporary parameters file', () => {
  assert.match(script, /RandomNumberGenerator/);
  assert.match(script, /New-RandomCredential/);
  assert.ok(script.includes('workloadToken = @{ value = $workloadToken }'));
  assert.ok(script.includes('trialRequestKey = @{ value = $trialRequestKey }'));
  assert.match(script, /Write-PrivateParameterFile/);
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /chmod 700/);
  assert.match(script, /chmod 600/);
  assert.match(script, /Remove-Item -LiteralPath \$tempDirectory -Recurse -Force/);
  assert.doesNotMatch(script, /Write-Output[^\n]*(?:workloadToken|trialRequestKey|workloadToken\s*=|trialRequestKey\s*=)/i);
});

test('group cleanup runs in finally and the private health probe originates on controller VM', () => {
  assert.match(script, /finally\s*\{[\s\S]*?container','delete'[\s\S]*?cleanupConfirmed/);
  assert.match(script, /'vm','run-command','invoke'[\s\S]*?'RunShellScript'/);
  assert.match(script, /http:\/\/__ACI_PRIVATE_IP__:8080\/health/);
  assert.match(script, /ACI_HEALTH_PROBE_BEGIN/);
  assert.match(script, /ACI_HEALTH_CURL_EXIT=\$\?/);
  assert.match(script, /"ready":true/);
  assert.match(script, /failureStage = 'private-health-probe'/);
  assert.match(script, /ACI_HEALTH_CURL_EXIT=\(\\d\+\)/);
  assert.match(script, /private-health-curl-/);
  assert.doesNotMatch(script, /node -e/);
  assert.match(script, /aci-health-smoke\.invalid/);
  assert.match(script, /dummyBlobEndpoint = 'https:\/\/acihealth'.*\.blob\.core\.windows\.net\//);
  assert.match(script, /reserved \.invalid research endpoints/i);
});

test('script refuses an ACI subnet without NAT, delegation, or with a route table', () => {
  assert.match(script, /subnet\.nat/);
  assert.match(script, /subnet\.routeTable/);
  assert.match(script, /Microsoft\.ContainerInstance\/containerGroups/);
});
