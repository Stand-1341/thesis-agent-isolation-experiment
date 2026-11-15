import test from 'node:test';
import assert from 'node:assert/strict';
import {isTransientAzureFailure, withRetry, makeCheckpointStore, makeAzRunner, formatFailures} from './common.mjs';
import {evaluatePreflight, evaluateWhatIf, cidrsOverlap, REQUIRED_PROVIDERS, runTemplateWhatIf, runBootstrapWhatIf, runThreeArmWhatIf, runRegionalP3WhatIf, buildBootstrapWhatIfParameters, buildThreeArmWhatIfParameters, runPostFoundationWhatIfGate} from './preflight.mjs';
import {hashBuildContext, prepareImageBuildContext, resolveImageDigest} from './publish-images.mjs';
import {defaultResourcePrefix, deriveP3RegionLocation, defaultNetworkSourcePrefixes, isOperatorIpv4HostCidr} from './resolve-inputs.mjs';
import {resolveConfiguration, renderExperimentConfig} from './configure.mjs';
import {createValidationReport, evaluatePresence, evaluatePermissionProbes, isValidationReportValid} from './validate-deployment.mjs';
import {evaluateTeardownGuard, identifyChargedSurvivors, parseArgs} from './teardown.mjs';
import {protocolDigest, evaluateStudyGates, readAuthorization} from './study-execute.mjs';
import {buildManifest, renderReport, DESIGN_BLOCKERS, validateReadinessPilotEvidence} from './readiness-report.mjs';
import {readFile, writeFile, mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const PASS_FACTS = {
  subscription: {id: '00000000-0000-0000-0000-000000000000', state: 'Enabled'},
  rolePermissions: [{actions: ['*']}],
  providers: Object.fromEntries(REQUIRED_PROVIDERS.map(p => [p, 'Registered'])),
  regionAvailable: true,
  quota: {vmFamilyLimit: 50, vmFamilyUsed: 4, vmNeeded: 4},
  skuRestricted: [],
  existingVnetPrefixes: ['10.20.0.0/16'],
  vnetInventoryVerified: true,
  budgetPresent: true,
  skipBudget: false
};

test('common: transient Azure failure detection', () => {
  assert.equal(isTransientAzureFailure({exitCode: 1, stderr: 'RequestTimeout: try again'}), true);
  assert.equal(isTransientAzureFailure({exitCode: 1, stderr: 'ValidationError: bad template'}), false);
  assert.equal(isTransientAzureFailure({exitCode: 0}), false);
});

test('preflight: what-if must exist and contain no deletes', () => {
  assert.equal(evaluateWhatIf(undefined).ok, false);
  assert.equal(evaluateWhatIf({}).ok, false);
  assert.equal(evaluateWhatIf({changes: [{changeType: 'Modify', resourceId: '/x'}]}).ok, true);
  assert.match(evaluateWhatIf({changes: [{changeType: 'Delete', resourceId: '/x'}]}).problem, /Delete/);
  assert.match(evaluateWhatIf({changes: [{changeType: 'Ignore', resourceId: '/x'}]}).problem, /did not validate.*Ignore/);
  assert.match(evaluateWhatIf({changes: [{changeType: 'Deploy', resourceId: '/x'}]}).problem, /could not determine.*Deploy/);
  const skipped=evaluateWhatIf({changes:[{changeType:'Create',resourceId:'/x'}],diagnostics:[{code:'NestedDeploymentSkippedFromInternalExpansion',message:'nested module skipped',target:'/subscriptions/s/resourceGroups/r/providers/Microsoft.Resources/deployments/regional-p3'}]});
  assert.equal(skipped.ok,false);
  assert.match(skipped.problem,/regional-p3/);
  assert.equal(evaluateWhatIf({changes:[{changeType:'Create',resourceId:'/x',statusMessage:'NestedDeploymentShortCircuited'}]}).ok,false);
  assert.equal(evaluateWhatIf({changes:[{changeType:'Unexpected',resourceId:'/x'}]}).ok,false);
});

test('preflight: invokes the real entry Bicep template with parsed source prefixes', async () => {
  let command;
  await runTemplateWhatIf({
    stage:'full',
    resourceGroup: 'rg', env: {
      TRUSTED_CONTROLLER_IP: '203.0.113.5', CONTROLLER_SOURCE_PREFIXES: '["203.0.113.5/32"]', CONTROLLER_SOURCE_PREFIXES_CSV:'203.0.113.5/32',
      RESEARCH_SOURCE_PREFIXES: '["10.48.0.0/16"]', RESEARCH_SOURCE_PREFIXES_CSV:'10.48.0.0/16',
      COLLECTOR_SOURCE_PREFIXES: '["10.48.0.0/16"]', COLLECTOR_SOURCE_PREFIXES_CSV:'10.48.0.0/16',
      OPERATOR_SOURCE_PREFIXES: '["203.0.113.5/32"]', OPERATOR_SOURCE_PREFIXES_CSV:'203.0.113.5/32', AZURE_OPERATOR_PRINCIPAL_ID: '00000000-0000-4000-8000-000000000001', AZURE_SUBSCRIPTION_ID: 'sub'
    }, az: async args => {
      command = args;
      const parameterArg = args.find(arg => String(arg).startsWith('@'));
      const parameterJson = JSON.parse(await readFile(String(parameterArg).slice(1), 'utf8'));
      assert.equal(parameterJson.parameters.controllerSourcePrefixesCsv.value, '203.0.113.5/32');
      assert.equal(parameterJson.parameters.stage.value,'full','preflight must preview workload and regional modules before foundation');
      return {changes: []};
    }
  });
  assert.ok(command.includes('--template-file'));
  assert.ok(command.includes('--resource-group'));
  assert.ok(command.includes('--subscription'));
});

test('post-foundation child preview parameter builders exactly cover root module wiring',async()=>{
  const main=await readFile(new URL('../infra/main.bicep',import.meta.url),'utf8');
  assert.deepEqual([...main.matchAll(/^module\s+([A-Za-z][A-Za-z0-9]*)\s+/gm)].map(match=>match[1]),['bootstrap','threeArm','regionalP3'],
    'all root modules must have a direct-preview implementation');
  const moduleParamBlock=name=>{
    const start=main.indexOf(`module ${name} `);
    const paramsAt=main.indexOf('params: {',start);
    if(start<0||paramsAt<0) return undefined;
    const open=main.indexOf('{',paramsAt);let depth=0;
    for(let index=open;index<main.length;index++) {
      if(main[index]==='{') depth++;
      else if(main[index]==='}'&&--depth===0) return main.slice(open+1,index);
    }
  };
  const bootstrapBlock=moduleParamBlock('bootstrap');
  const threeArmBlock=moduleParamBlock('threeArm');
  assert.ok(bootstrapBlock);assert.ok(threeArmBlock);
  const explicitKeys=block=>[...block.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map(match=>match[1]).sort();
  const env={AZURE_NAME_PREFIX:'study',AZURE_LOCATION:'centralus',P3_REGION_LOCATION:'westus2',SERVERLESS_RUNTIME:'aca_jobs',
    TRUSTED_CONTROLLER_IP:'203.0.113.4',AZURE_OPERATOR_PRINCIPAL_ID:'11111111-1111-4111-8111-111111111111',
    SSH_PUBLIC_KEY:'ssh-ed25519 AAAA',VM_IMAGE_VERSION:'22.04.202601010',
    CONTROLLER_SOURCE_PREFIXES:'["198.51.100.1/32"]',RESEARCH_SOURCE_PREFIXES:'["10.48.0.0/16"]',
    COLLECTOR_SOURCE_PREFIXES:'["10.48.0.0/16"]',OPERATOR_SOURCE_PREFIXES:'["203.0.113.4/32"]',
    AGENT_IMAGE_DIGEST:`sha256:${'a'.repeat(64)}`,AGENT_REGISTRY_NAME:'studyacr',EVIDENCE_RETENTION_DAYS:'30'};
  const bootstrap=buildBootstrapWhatIfParameters(env);
  const threeArm=buildThreeArmWhatIfParameters(env,'studyvault');
  assert.deepEqual(Object.keys(bootstrap).sort(),explicitKeys(bootstrapBlock));
  assert.deepEqual(Object.keys(threeArm).sort(),explicitKeys(threeArmBlock));
  assert.deepEqual(threeArm.controllerSourcePrefixes,['198.51.100.1/32']);
  assert.deepEqual(threeArm.researchSourcePrefixes,['10.48.0.0/16']);
  assert.deepEqual(threeArm.collectorSourcePrefixes,['10.48.0.0/16']);
  assert.deepEqual(threeArm.operatorSourcePrefixes,['203.0.113.4/32']);
  assert.equal(threeArm.agentImageP1,`studyacr.azurecr.io/thesis/agent@sha256:${'a'.repeat(64)}`);
  assert.equal(threeArm.agentImageP1,threeArm.agentImageP2);
  assert.equal(threeArm.agentImageP2,threeArm.agentImageP3);
  assert.equal(threeArm.deployP3Firewall,false);
  assert.equal(threeArm.deployRegionalP3Support,true);
  assert.equal(threeArm.deployP3VmRoute,false);
  assert.equal(threeArm.deployP3SandboxGroup,false);
  assert.equal(threeArm.vaultName,'studyvault');
  assert.equal(threeArm.namePrefix,'study');
  assert.equal(threeArm.location,'centralus');
  assert.equal(threeArm.researchServicePrivateIp,'10.48.9.4');
  assert.equal(threeArm.collectorPrivateIp,'10.48.9.5');
  assert.equal(threeArm.restrictedServicePrivateIp,'10.48.9.6');
  assert.equal(threeArm.trustedControllerPublicIp,'203.0.113.4');
  assert.equal(threeArm.sshPublicKey,'ssh-ed25519 AAAA');
  assert.equal(threeArm.vmImageVersion,'22.04.202601010');
  assert.deepEqual(Object.fromEntries(Object.entries(threeArm).filter(([key])=>key.startsWith('deploy')||key==='createRecordUpdateRole'||key==='linkVaultSecretReader')),
    {deployVmArm:true,deployJobs:true,deployFunctionsArm:false,deploySandboxGroups:true,deployP3Firewall:false,deployRegionalP3Support:true,deployP3VmRoute:false,
      deployP3SandboxGroup:false,deployEnvironmentNsg:true,deployEvidenceStore:true,deploySyntheticFixtures:true,
      createRecordUpdateRole:true,deployResearchHost:true,deployRegistryPrivateEndpoint:true,deployRegistryMetadataReader:true,linkVaultSecretReader:true});
  assert.equal(threeArm.evidenceRetentionDays,30);
  assert.match(main,/deployP3Firewall: enableWorkloads && \(enableFunctions \|\| !deployRegionalP3\)/);
  assert.match(main,/deployRegionalP3Support: prepareRegionalP3Support/);
  assert.match(main,/vaultName: effectiveWorkloadTokenVaultName/);
  assert.match(main,/agentImageP1: enableWorkloads && !empty\(agentImageDigest\)[\s\S]*agentImageP2: enableWorkloads && !empty\(agentImageDigest\)[\s\S]*agentImageP3: enableWorkloads && !empty\(agentImageDigest\)/);
  assert.throws(()=>buildThreeArmWhatIfParameters({...env,AGENT_IMAGE_DIGEST:''},'studyvault'),/pinned AGENT_IMAGE_DIGEST/);
});

test('complete primary post-foundation preview avoids unnecessary direct-child previews',async()=>{
  const guid='11111111-1111-4111-8111-111111111111';let calls=[];
  const env={AZURE_SUBSCRIPTION_ID:guid,AZURE_NAME_PREFIX:'study',AZURE_LOCATION:'centralus',
    TRUSTED_CONTROLLER_IP:'203.0.113.4',AZURE_OPERATOR_PRINCIPAL_ID:guid,SSH_PUBLIC_KEY:'ssh-ed25519 AAAA',
    VM_IMAGE_VERSION:'22.04.202601010',CONTROLLER_SOURCE_PREFIXES:'["198.51.100.1/32"]',
    RESEARCH_SOURCE_PREFIXES:'["10.48.0.0/16"]',COLLECTOR_SOURCE_PREFIXES:'["10.48.0.0/16"]',
    OPERATOR_SOURCE_PREFIXES:'["203.0.113.4/32"]',AGENT_IMAGE_DIGEST:`sha256:${'b'.repeat(64)}`};
  const az=async args=>{
    calls.push(args);
    if(args.includes('show')) return {properties:{outputs:{vaultName:{value:'studyvault'}}}};
    const template=args[args.indexOf('--template-file')+1];
    if(template.endsWith('main.bicep')) return {changes:[]};
    assert.ok(template.endsWith('bootstrap-prerequisites.bicep')||template.endsWith('azure-supported-three-arm.bicep'));
    const parameterArg=args.find(value=>String(value).startsWith('@'));
    const parameters=JSON.parse(await readFile(String(parameterArg).slice(1),'utf8')).parameters;
    if(template.endsWith('bootstrap-prerequisites.bicep')) assert.equal(parameters.existingVaultName.value,'');
    else assert.equal(parameters.vaultName.value,'studyvault');
    return {changes:[]};
  };
  const gate=await runPostFoundationWhatIfGate({az,resourceGroup:'rg',env});
  assert.deepEqual(gate,{ok:true});
  assert.equal(calls.filter(args=>args.includes('what-if')).length,1,'complete primary What-If requires no fallback');
});

test('post-foundation nested skip is accepted only after a non-destructive change scan',async()=>{
  const guid='11111111-1111-4111-8111-111111111111';let calls=[];
  const env={AZURE_SUBSCRIPTION_ID:guid,AZURE_NAME_PREFIX:'study',AZURE_LOCATION:'centralus',
    TRUSTED_CONTROLLER_IP:'203.0.113.4',AZURE_OPERATOR_PRINCIPAL_ID:guid,SSH_PUBLIC_KEY:'ssh-ed25519 AAAA',
    VM_IMAGE_VERSION:'22.04.202601010',CONTROLLER_SOURCE_PREFIXES:'["198.51.100.1/32"]',
    RESEARCH_SOURCE_PREFIXES:'["10.48.0.0/16"]',COLLECTOR_SOURCE_PREFIXES:'["10.48.0.0/16"]',
    OPERATOR_SOURCE_PREFIXES:'["203.0.113.4/32"]',AGENT_IMAGE_DIGEST:`sha256:${'b'.repeat(64)}`};
  const az=async args=>{
    calls.push(args);
    if(args.includes('show')) return {properties:{outputs:{vaultName:{value:'studyvault'}}}};
    const template=args[args.indexOf('--template-file')+1];
    if(template.endsWith('main.bicep')) return {changes:[{changeType:'Ignore',resourceId:`/subscriptions/${guid}/resourceGroups/rg/providers/Microsoft.Resources/deployments/thesis-three-arm-full`}],
      diagnostics:[{code:'NestedDeploymentSkippedFromInternalExpansion',target:`/subscriptions/${guid}/resourceGroups/rg/providers/Microsoft.Resources/deployments/study-vm-p1`}]};
    return {changes:[]};
  };
  const result=await runPostFoundationWhatIfGate({az,resourceGroup:'rg',env});
  assert.equal(result.ok,true);
  assert.match(result.warning,/non-destructive/);
  assert.equal(calls.filter(args=>args.includes('what-if')).length,1,'recognized nested short-circuit is scanned without a second preview');
});

test('post-foundation child preview remains blocked on destructive or indeterminate changes',async()=>{
  const guid='11111111-1111-4111-8111-111111111111';
  const env={AZURE_SUBSCRIPTION_ID:guid,AZURE_NAME_PREFIX:'study',AZURE_LOCATION:'centralus',
    TRUSTED_CONTROLLER_IP:'203.0.113.4',AZURE_OPERATOR_PRINCIPAL_ID:guid,SSH_PUBLIC_KEY:'ssh-ed25519 AAAA',
    VM_IMAGE_VERSION:'22.04.202601010',CONTROLLER_SOURCE_PREFIXES:'["198.51.100.1/32"]',
    RESEARCH_SOURCE_PREFIXES:'["10.48.0.0/16"]',COLLECTOR_SOURCE_PREFIXES:'["10.48.0.0/16"]',
    OPERATOR_SOURCE_PREFIXES:'["203.0.113.4/32"]',AGENT_IMAGE_DIGEST:`sha256:${'b'.repeat(64)}`};
  const az=async args=>{
    if(args.includes('show')) return {properties:{outputs:{vaultName:{value:'studyvault'}}}};
    const template=args[args.indexOf('--template-file')+1];
    if(template.endsWith('main.bicep')) return {changes:[{changeType:'Delete',resourceId:'/resources/must-not-delete'}],
      diagnostics:[{code:'NestedDeploymentSkippedFromInternalExpansion',target:'/deployments/thesis-three-arm-full'}]};
    return {changes:[]};
  };
  const result=await runPostFoundationWhatIfGate({az,resourceGroup:'rg',env});
  assert.equal(result.ok,false);
  assert.match(result.problem,/primary-full: ARM what-if did not validate 1 nested deployment/);
});

test('post-foundation gate permits only exact superseded Jobs ignores in Functions mode',async()=>{
  const guid='11111111-1111-4111-8111-111111111111';
  const baseEnv={AZURE_SUBSCRIPTION_ID:guid,AZURE_NAME_PREFIX:'study',AZURE_LOCATION:'centralus',SERVERLESS_RUNTIME:'functions_flex',
    TRUSTED_CONTROLLER_IP:'203.0.113.4',CONTROLLER_SOURCE_PREFIXES:'["198.51.100.1/32"]',
    RESEARCH_SOURCE_PREFIXES:'["10.48.0.0/16"]',COLLECTOR_SOURCE_PREFIXES:'["10.48.0.0/16"]',
    OPERATOR_SOURCE_PREFIXES:'["203.0.113.4/32"]',AZURE_OPERATOR_PRINCIPAL_ID:guid};
  const legacyJob=`/subscriptions/${guid}/resourceGroups/rg/providers/Microsoft.App/jobs/study-job-p1`;
  const preview=resourceId=>async args=>args.includes('what-if')?{changes:[{changeType:'Ignore',resourceId}]}:{};
  assert.deepEqual(await runPostFoundationWhatIfGate({az:preview(legacyJob),resourceGroup:'rg',env:baseEnv}),{ok:true});
  const wrongRg=await runPostFoundationWhatIfGate({az:preview(legacyJob.replace('/rg/','/other-rg/')),resourceGroup:'rg',env:baseEnv});
  assert.equal(wrongRg.ok,false);
  assert.match(wrongRg.problem,/Microsoft\.App\/jobs/);
  const jobsMode=await runPostFoundationWhatIfGate({az:preview(legacyJob),resourceGroup:'rg',
    env:{...baseEnv,SERVERLESS_RUNTIME:'aca_jobs'}});
  assert.equal(jobsMode.ok,false);
  assert.match(jobsMode.problem,/Microsoft\.App\/jobs/);
  const extensionRole=`[extensionResourceId('/subscriptions/${guid}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/studyevd/blobServices/default/containers/trial-evidence', 'Microsoft.Authorization/roleAssignments', guid('scope', 'principal', 'blob-reader'))]`;
  const unsupported=changes=>async args=>args.includes('what-if')?{changes}:{};
  assert.deepEqual(await runPostFoundationWhatIfGate({az:unsupported([{changeType:'Unsupported',resourceId:extensionRole}]),
    resourceGroup:'rg',env:baseEnv}),{ok:true});
  const otherUnsupported=await runPostFoundationWhatIfGate({az:unsupported([{changeType:'Unsupported',
    resourceId:extensionRole.replace('/rg/','/other-rg/')}]),resourceGroup:'rg',env:baseEnv});
  assert.equal(otherUnsupported.ok,false);
  assert.match(otherUnsupported.problem,/does not support 1 resource/);
});

test('post-foundation gate refuses an unrecognized nested skip target',async()=>{
  const guid='11111111-1111-4111-8111-111111111111';
  const result=await runPostFoundationWhatIfGate({resourceGroup:'rg',env:{AZURE_SUBSCRIPTION_ID:guid,AZURE_LOCATION:'centralus',
    TRUSTED_CONTROLLER_IP:'203.0.113.4',CONTROLLER_SOURCE_PREFIXES:'["198.51.100.1/32"]',
    RESEARCH_SOURCE_PREFIXES:'["10.48.0.0/16"]',COLLECTOR_SOURCE_PREFIXES:'["10.48.0.0/16"]',
    OPERATOR_SOURCE_PREFIXES:'["203.0.113.4/32"]',AZURE_OPERATOR_PRINCIPAL_ID:guid},az:async args=>
    args.includes('what-if')?{changes:[],diagnostics:[{code:'NestedDeploymentShortCircuited',target:'/deployments/unreviewed-module',message:'nested skipped'}]}:{}});
  assert.equal(result.ok,false);
  assert.match(result.problem,/primary-full: ARM what-if did not validate/);
});

test('regional P3 return tables are created in foundation and receive exact routes only in full', async()=>{
  const main=await readFile(new URL('../infra/main.bicep',import.meta.url),'utf8');
  const threeArm=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/azure-supported-three-arm.bicep',import.meta.url),'utf8');
  const routeTables=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/regional-hub-return-route-tables.bicep',import.meta.url),'utf8');
  const host=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/research-host-pilot.bicep',import.meta.url),'utf8');
  assert.match(main,/deployRegionalP3Support: prepareRegionalP3Support/);
  assert.match(main,/module regionalP3[\s\S]*?= if \(deployRegionalP3\)/);
  assert.match(main,/sharedHubRouteTableResourceId: threeArm\.outputs\.regionalNetworkSupport\.serviceReturnRouteTableId/);
  assert.match(main,/sharedHubPrivateEndpointRouteTableResourceId: threeArm\.outputs\.regionalNetworkSupport\.privateEndpointReturnRouteTableId/);
  assert.match(threeArm,/createRegionalReturnRouteTables = deployRegionalP3Support && !deployVmArm && !deployP3Firewall/);
  assert.match(threeArm,/routeTable: deployP3Firewall \? \{ id: serviceReturnRouteTable\.id \} : \(deployRegionalP3Support \? \{ id: serviceReturnRouteTableId \} : null\)/);
  assert.match(threeArm,/routeTable: deployP3Firewall \? \{ id: privateEndpointReturnRouteTable\.id \} : \(deployRegionalP3Support \? \{ id: privateEndpointReturnRouteTableId \} : null\)/);
  assert.match(routeTables,/properties: \{ routes: \[\] \}/);
  assert.match(host,/name: 'research',[\s\S]*privateIPAllocationMethod: 'Static',[\s\S]*privateIPAddress: researchServicePrivateIp/);
  assert.match(host,/name: 'collector',[\s\S]*privateIPAllocationMethod: 'Static',[\s\S]*privateIPAddress: collectorPrivateIp/);
  assert.match(threeArm,/researchServicePrivateIp: researchServicePrivateIp[\s\S]*collectorPrivateIp: collectorPrivateIp/);
  assert.match(main,/param researchServicePrivateIp string = '10\.48\.9\.4'/);
  assert.match(main,/param collectorPrivateIp string = '10\.48\.9\.5'/);
  assert.match(main,/researchServicePrivateIp: researchServicePrivateIp[\s\S]*collectorPrivateIp: collectorPrivateIp[\s\S]*restrictedServicePrivateIp: restrictedServicePrivateIp/);
  assert.match(await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/hub-p3-return-routes.bicep',import.meta.url),'utf8'),/addressPrefix: prefix[\s\S]*nextHopType: 'VirtualAppliance'[\s\S]*nextHopIpAddress: firewallPrivateIp/);
});

test('regional P3 direct preview binds fixed service IPs and actual foundation outputs',async()=>{
  const guid='00000000-0000-4000-8000-000000000001';
  const id=(type,name)=>`/subscriptions/${guid}/resourceGroups/study/providers/${type}/${name}`;
  let command,preview;
  const foundationOutputs={
    logWorkspaceId:id('Microsoft.OperationalInsights/workspaces','study-logs'),registryServer:'studyacr.azurecr.io',
    virtualNetworkId:id('Microsoft.Network/virtualNetworks','study-vnet'),imagePullIdentityResourceId:id('Microsoft.ManagedIdentity/userAssignedIdentities','study-pull'),
    imagePullIdentityClientId:guid,
    sandboxControlIdentityResourceId:id('Microsoft.ManagedIdentity/userAssignedIdentities','study-sandbox-control'),sandboxControlIdentityObjectId:guid,
    jobP3WorkloadIdentityResourceId:id('Microsoft.ManagedIdentity/userAssignedIdentities','study-job-p3'),jobP3WorkloadClientId:guid,jobP3WorkloadObjectId:guid,
    experimentConfigRoutes:{azure_vm:{P3:{workloadIdentityResourceId:id('Microsoft.ManagedIdentity/userAssignedIdentities','study-vm-p3'),secretReaderIdentityResourceId:id('Microsoft.ManagedIdentity/userAssignedIdentities','study-vm-p3-reader')}}},
    routeSecretReaderIdentities:{aca_jobs:{P3:{resourceId:id('Microsoft.ManagedIdentity/userAssignedIdentities','study-job-p3-reader'),clientId:guid}}},
    regionalNetworkSupport:{
      serviceReturnRouteTableId:id('Microsoft.Network/routeTables','study-svc-return-routes'),
      privateEndpointReturnRouteTableId:id('Microsoft.Network/routeTables','study-pe-return-routes'),
      blobPrivateDnsZoneId:id('Microsoft.Network/privateDnsZones','privatelink.blob.core.windows.net'),
      registryPrivateDnsZoneId:id('Microsoft.Network/privateDnsZones','privatelink.azurecr.io'),
      fixtureEndpointPrivateIp:'10.48.4.22',evidenceEndpointPrivateIp:'10.48.4.21'
    }
  };
  await runRegionalP3WhatIf({az:async args=>{
    command=args;
    const file=args.find(value=>String(value).startsWith('@'));
    preview=JSON.parse(await readFile(String(file).slice(1),'utf8'));
    return {changes:[]};
  },resourceGroup:'study',foundationOutputs,env:{
    AZURE_SUBSCRIPTION_ID:guid,AZURE_NAME_PREFIX:'study',P3_REGION_LOCATION:'westus2',
    CONTROLLER_SOURCE_PREFIXES:'["198.51.100.24/32"]',VM_IMAGE_VERSION:'22.04.202601010',SSH_PUBLIC_KEY:'ssh-ed25519 AAAA',
    AGENT_IMAGE_DIGEST:`sha256:${'a'.repeat(64)}`
  }});
  assert.ok(command.includes(path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/regional-p3-spoke.bicep')));
  assert.equal(preview.parameters.researchServicePrivateIp.value,'10.48.9.4');
  assert.equal(preview.parameters.collectorPrivateIp.value,'10.48.9.5');
  assert.equal(preview.parameters.restrictedServicePrivateIp.value,'10.48.9.6');
  assert.deepEqual(preview.parameters.sharedPrivateDnsZoneResourceIds.value,[foundationOutputs.regionalNetworkSupport.blobPrivateDnsZoneId,foundationOutputs.regionalNetworkSupport.registryPrivateDnsZoneId]);
  assert.equal(preview.parameters.jobsReaderIdentityResourceId.value,foundationOutputs.routeSecretReaderIdentities.aca_jobs.P3.resourceId);
});

test('resolve-inputs: default resource prefix is subscription-specific and Azure-safe', () => {
  const prefix = defaultResourcePrefix('12345678-90ab-cdef-1234-567890abcdef');
  assert.match(prefix, /^th[a-f0-9]{8}$/);
  assert.equal(prefix.length <= 10, true);
  assert.equal(defaultResourcePrefix(undefined), undefined);
});

test('resolve-inputs: bootstrap lock ingress requires one exact public IPv4 /32',()=>{
  assert.equal(isOperatorIpv4HostCidr('203.0.113.7/32'),true);
  assert.equal(isOperatorIpv4HostCidr('203.0.113.7'),false);
  assert.equal(isOperatorIpv4HostCidr('203.0.113.0/24'),false);
  assert.equal(isOperatorIpv4HostCidr('300.0.0.1/32'),false);
});

test('resolve-inputs derives P3 region from azd JSON route map and exact planned source subnets',()=>{
  const routeRegions=JSON.stringify({
    azure_vm:{P1:'centralus',P2:'centralus',P3:'westus2'},
    azure_container_apps_jobs:{P1:'centralus',P2:'centralus',P3:'westus2'},
    azure_container_apps_sandboxes:{P1:'centralus',P2:'centralus',P3:'westus2'}
  });
  const p3=deriveP3RegionLocation({routeRegions});
  assert.equal(p3,'westus2');
  assert.deepEqual(defaultNetworkSourcePrefixes({trustedControllerIp:'198.51.100.24/32',location:'centralus',p3RegionLocation:p3,serverlessRuntime:'aca_jobs'}),{
    controller:['198.51.100.24/32'],operator:['198.51.100.24/32'],
    research:['10.48.0.0/24','10.48.7.0/24','10.48.12.0/27','10.52.2.0/24','10.52.12.0/27'],
    collector:['10.48.0.0/24','10.48.7.0/24','10.48.12.0/27']
  });
});

test('common: withRetry retries transient then succeeds', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls < 3) { const e = new Error('429 throttl'); e.exitCode = 1; throw e; }
    return 'ok';
  };
  const retried = withRetry(run, {attempts: 4, baseDelayMs: 1, sleep: async () => {}, jitter: () => 0});
  assert.equal(await retried('x'), 'ok');
  assert.equal(calls, 3);
});

test('common: withRetry does not retry non-transient', async () => {
  let calls = 0;
  const run = async () => { calls += 1; const e = new Error('ValidationError'); e.exitCode = 1; throw e; };
  const retried = withRetry(run, {attempts: 4, baseDelayMs: 1, sleep: async () => {}, jitter: () => 0});
  await assert.rejects(retried('x'));
  assert.equal(calls, 1);
});

test('common: checkpoint store marks, reads and clears', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ck-'));
  const store = makeCheckpointStore({statePath: path.join(dir, 'state.json'), now: () => '2026-11-12T00:00:00Z'});
  assert.equal(await store.has('step1'), false);
  await store.mark('step1', {digest: 'sha256:abc'});
  assert.equal(await store.has('step1'), true);
  const state = await store.load();
  assert.equal(state.checkpoints.step1.digest, 'sha256:abc');
  await store.clear('step1');
  assert.equal(await store.has('step1'), false);
  await rm(dir, {recursive: true, force: true});
});

test('preflight: cidrsOverlap basic cases', () => {
  assert.equal(cidrsOverlap('10.48.0.0/16', '10.48.9.0/24'), true);
  assert.equal(cidrsOverlap('10.48.0.0/16', '10.49.0.0/16'), false);
  assert.equal(cidrsOverlap('0.0.0.0/0', '192.168.0.0/24'), true);
});

test('preflight: healthy subscription passes', () => {
  const result = evaluatePreflight(PASS_FACTS);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test('preflight: Microsoft.App environment quota gates required environments', () => {
  const result = evaluatePreflight({...PASS_FACTS, quota: {...PASS_FACTS.quota, appManagedEnvironmentLimit: 3, appManagedEnvironmentUsed: 2, appManagedEnvironmentsNeeded: 2}});
  assert.ok(result.failures.some(f => f.check === 'quota' && /managed environment headroom is 1/.test(f.problem)));
});

test('azd parameter template uses valid CSV companion strings for source prefixes', async () => {
  const parameters = JSON.parse(await readFile(new URL('../infra/main.parameters.json', import.meta.url), 'utf8')).parameters;
  assert.equal(parameters.controllerSourcePrefixesCsv.value, '${CONTROLLER_SOURCE_PREFIXES_CSV}');
  assert.equal(parameters.researchSourcePrefixesCsv.value, '${RESEARCH_SOURCE_PREFIXES_CSV}');
  assert.equal(parameters.collectorSourcePrefixesCsv.value, '${COLLECTOR_SOURCE_PREFIXES_CSV}');
  assert.equal(parameters.operatorSourcePrefixesCsv.value, '${OPERATOR_SOURCE_PREFIXES_CSV}');
  assert.equal(parameters.researchServicePrivateIp.value, '${RESEARCH_SERVICE_PRIVATE_IP}');
  assert.equal(parameters.collectorPrivateIp.value, '${COLLECTOR_PRIVATE_IP}');
  assert.equal(parameters.restrictedServicePrivateIp.value, '${RESTRICTED_SERVICE_PRIVATE_IP}');
  assert.equal(parameters.workloadTokenVaultName.value, '${WORKLOAD_TOKEN_VAULT_NAME}');
});

test('preflight: unregistered provider fails with fix', () => {
  const facts = {...PASS_FACTS, providers: {...PASS_FACTS.providers, 'Microsoft.App': 'NotRegistered'}};
  const {failures} = evaluatePreflight(facts);
  assert.equal(failures.length, 1);
  assert.match(failures[0].fix, /az provider register --namespace Microsoft.App/);
});

test('preflight: missing role assignment permission fails', () => {
  const facts = {...PASS_FACTS, rolePermissions: [{actions: ['Microsoft.Resources/deployments/write']}]};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'rbac' && f.problem.includes('roleAssignments/write')));
});

test('preflight: quota headroom shortfall fails', () => {
  const facts = {...PASS_FACTS, quota: {vmFamilyLimit: 6, vmFamilyUsed: 4, vmNeeded: 4}};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'quota'));
});

test('preflight: address-space overlap with existing vnet fails', () => {
  const facts = {...PASS_FACTS, existingVnetPrefixes: ['10.48.100.0/24']};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'address-space' && f.problem.includes('10.48.100.0/24')));
});

test('preflight: SKU restriction fails', () => {
  const facts = {...PASS_FACTS, skuRestricted: ['Standard_F1as_v7']};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'sku'));
});

test('preflight: missing budget fails unless skipped', () => {
  const facts = {...PASS_FACTS, budgetPresent: false};
  assert.ok(evaluatePreflight(facts).failures.some(f => f.check === 'budget'));
  assert.equal(evaluatePreflight({...facts, skipBudget: true}).failures.length, 0);
});

test('preflight: disabled subscription fails auth gate', () => {
  const facts = {...PASS_FACTS, subscription: {...PASS_FACTS.subscription, state: 'Disabled'}};
  assert.ok(evaluatePreflight(facts).failures.some(f => f.check === 'auth'));
});

test('publish-images: build context hash is stable and content-sensitive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ctx-'));
  await mkdir(path.join(dir, 'dist'));
  for (const file of ['Dockerfile.node', '.dockerignore', 'package.json', 'package-lock.json', 'dist/agent.js']) await writeFile(path.join(dir, file), 'initial');
  const caPath=path.join(dir,'preprovisioned-ca.pem');
  const ca=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/certs/thesis-pilot-ca.pem',import.meta.url));
  await writeFile(caPath,ca);
  const a = await hashBuildContext({dir,caCertificatePath:caPath});
  const b = await hashBuildContext({dir,caCertificatePath:caPath});
  assert.equal(a, b);
  await writeFile(path.join(dir, 'dist/agent.js'), 'changed compiled workload');
  const c = await hashBuildContext({dir,caCertificatePath:caPath});
  assert.notEqual(a, c);
  await rm(dir, {recursive: true, force: true});
});

test('publish-images: the exact preprovisioned public CA is hashed and copied into the temporary Docker context', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'ctx-ca-'));
  try {
    await mkdir(path.join(dir,'dist'));
    for(const file of ['Dockerfile.node','.dockerignore','package.json','package-lock.json','dist/agent.js']) await writeFile(path.join(dir,file),file);
    const caPath=path.join(dir,'operator-ca.pem');
    const ca=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/certs/thesis-pilot-ca.pem',import.meta.url));
    await writeFile(caPath,ca);
    const base=await hashBuildContext({dir,caCertificatePath:caPath});
    const context=await prepareImageBuildContext({dir,caCertificatePath:caPath});
    try {
      assert.deepEqual(await readFile(path.join(context,'certs/thesis-pilot-ca.pem')),ca);
      assert.equal(await readFile(path.join(context,'Dockerfile.node'),'utf8'),'Dockerfile.node');
    } finally { await rm(context,{recursive:true,force:true}); }
    await writeFile(caPath,Buffer.concat([ca,Buffer.from('\n')]));
    assert.notEqual(base,await hashBuildContext({dir,caCertificatePath:caPath}));
    await assert.rejects(prepareImageBuildContext({dir}),/THESIS_RESEARCH_CA_CERT/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('publish-images: resolveImageDigest validates digest shape', async () => {
  const good = 'sha256:' + 'a'.repeat(64);
  const az = async args => {
    if (args[1] === 'repository' && args[2] === 'show') return good;
    throw new Error('unexpected call');
  };
  assert.equal(await resolveImageDigest({az, registry: 'r'}), good);
  const badAz = async () => 'latest';
  await assert.rejects(resolveImageDigest({az: badAz, registry: 'r'}), /non-digest/);
});

const GOOD_OUTPUTS = {
  registryServer: 'thesisacr',
  controllerIdentityClientId: '11111111-1111-1111-1111-111111111111',
  controllerIdentityObjectId: '22222222-2222-2222-2222-222222222222',
  verifierIdentityObjectId: '33333333-3333-3333-3333-333333333333',
  secretReaderIdentityObjectId: '44444444-4444-4444-4444-444444444444',
  fixtureOwnerIdentityObjectId: '55555555-5555-5555-5555-555555555555',
  sandboxControlIdentityClientId: '66666666-6666-6666-6666-666666666666',
  imagePullIdentityResourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.ManagedIdentity/userAssignedIdentities/imgpull',
  imagePullIdentityClientId: '77777777-7777-4777-8777-777777777777',
  virtualNetworkId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/virtualNetworks/vnet',
  researchServicePrivateIp: '10.48.9.4',
  collectorPrivateIp: '10.48.9.5',
  evidenceAccountId: '/subscriptions/x/evidence',
  evidenceContainerUrl: 'https://evidence.blob.core.windows.net/evd',
  fixtureAccountId: '/subscriptions/x/fixture',
  fixtureBlobEndpoint: 'https://fixture.blob.core.windows.net/fx',
  fixtureBlobResourceId: '/subscriptions/x/fixture/blobServices/default',
  logWorkspaceId: '/subscriptions/x/logs',
  jobsEnvironmentId: 'env1',
  jobsP3EnvironmentId: 'env2',
  experimentConfigRoutes: {
    azure_vm: {
      P1: {principalObjectId: 'a', resourceId: '/subscriptions/x/vmP1'},
      P2: {principalObjectId: 'b', resourceId: '/subscriptions/x/vmP2'},
      P3: {principalObjectId: 'c', resourceId: '/subscriptions/x/vmP3'}
    },
    aca_jobs: {
      P1: {principalObjectId: 'd', clientId: 'd1', resourceId: '/subscriptions/x/jobP1'},
      P2: {principalObjectId: 'e', clientId: 'e1', resourceId: '/subscriptions/x/jobP2'},
      P3: null
    },
    aca_sandboxes: {
      P1: {principalObjectId: 'f', clientId: 'f1', sandboxGroupId: '/subscriptions/x/sbP1'},
      P2: {principalObjectId: 'g', clientId: 'g1', sandboxGroupId: '/subscriptions/x/sbP2'},
      P3: {principalObjectId: 'h', clientId: 'h1', sandboxGroupId: '/subscriptions/x/sbP3'}
    }
  }
};

test('configure: healthy outputs resolve without problems', () => {
  const {problems, resolved} = resolveConfiguration({outputs: GOOD_OUTPUTS, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  assert.deepEqual(problems, []);
  assert.equal(resolved.identities.controller.clientId, '11111111-1111-1111-1111-111111111111');
});

test('configure: missing infra output reports the exact key', () => {
  const outputs = {...GOOD_OUTPUTS, verifierIdentityObjectId: ''};
  const {problems} = resolveConfiguration({outputs, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  assert.ok(problems.some(p => p.includes('verifierIdentityObjectId')));
});

test('configure: route with no principal is reported', () => {
  const outputs = structuredClone(GOOD_OUTPUTS);
  outputs.experimentConfigRoutes.aca_jobs.P2.principalObjectId = '';
  const {problems} = resolveConfiguration({outputs, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  assert.ok(problems.some(p => p.includes('aca_jobs/P2')));
});

test('configure: experiment config renders deployed/undeployed routes and flags missing image', () => {
  const {resolved} = resolveConfiguration({outputs: GOOD_OUTPUTS, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  const rendered = renderExperimentConfig({resolved, env: {}});
  assert.equal(rendered.config.routes.some(route => route.deployment === 'aca_jobs' && route.profile === 'P3'), false);
  assert.ok(rendered.config.routes.some(route => route.deployment === 'azure_vm' && route.profile === 'P1'));
  assert.equal(rendered.config.deployments.azure_vm.kind, 'http');
  assert.ok(rendered.problems.some(p => p.includes('AGENT_IMAGE_DIGEST')));
  const resolvedWithImage = resolveConfiguration({outputs: GOOD_OUTPUTS, env: {AZURE_SUBSCRIPTION_ID: 'sub', AGENT_IMAGE_DIGEST: 'sha256:' + 'f'.repeat(64)}}).resolved;
  const withImage = renderExperimentConfig({resolved: resolvedWithImage, env: {}});
  assert.deepEqual(withImage.problems, []);
  assert.equal(withImage.config.routes.some(route => route.deployment === 'aca_jobs' && route.profile === 'P3'), false);
  assert.ok(Array.isArray(withImage.config.routes));
});

test('validate: presence check flags missing resources', () => {
  const resolved = {workloads: GOOD_OUTPUTS.experimentConfigRoutes};
  const resourceIds = ['/subscriptions/x/vmP1', '/subscriptions/x/vmP2'];
  const {failures} = evaluatePresence({resolved, resourceIds});
  // vmP3, jobP1, jobP2 and all three sandbox groups are expected but absent.
  assert.equal(failures.length, 6);
  assert.ok(failures.every(f => f.check === 'V1'));
});

test('validate: token-failed identity becomes an effective-permission failure', () => {
  const probes = [
    {identity: 'aca_jobs/P1', status: 'token-ok', hasToken: true, dataPlaneStatus: 200, expectedDataPlaneStatus: 200},
    {identity: 'aca_jobs/P2', status: 'token-failed', error: 'AADSTS50053'}
  ];
  const failures = evaluatePermissionProbes(probes);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].check, 'V3');
  assert.match(failures[0].fix, /data-plane probe/);
});

test('validate: token-ok without token also fails', () => {
  const failures = evaluatePermissionProbes([{identity: 'x', status: 'token-ok', hasToken: false}]);
  assert.equal(failures.length, 1);
});

test('teardown: guard allows when only validation blobs exist', () => {
  const decision = evaluateTeardownGuard({blobs: ['validation/non-counted-1.txt']});
  assert.equal(decision.allowed, true);
});

test('teardown: guard refuses when counted evidence present', () => {
  const decision = evaluateTeardownGuard({blobs: ['trials/2026/row-1.json']});
  assert.equal(decision.allowed, false);
  assert.match(decision.fix, /--export-evidence|--force/);
});

test('teardown: export option allows and counts exports', () => {
  const decision = evaluateTeardownGuard({blobs: ['trials/a.json', 'validation/x'], exportEvidence: '/tmp/ev'});
  assert.equal(decision.allowed, true);
  assert.equal(decision.exports, 1);
});

test('teardown: force is explicitly marked destructive', () => {
  const decision = evaluateTeardownGuard({blobs: ['trials/a.json'], force: true});
  assert.equal(decision.allowed, true);
  assert.equal(decision.destructive, true);
});

test('teardown: charged survivors exclude the managed group', () => {
  const survivors = identifyChargedSurvivors({
    subscriptionResources: [
      {id: '/subscriptions/x/resourceGroups/rg-managed/providers/Microsoft.Storage/storageAccounts/inside', type: 'Microsoft.Storage/storageAccounts'},
      {id: '/subscriptions/x/resourceGroups/rg-other/providers/Microsoft.Storage/storageAccounts/outside', type: 'Microsoft.Storage/storageAccounts'},
      {id: '/subscriptions/x/resourceGroups/rg-other/providers/Microsoft.Web/sites/irrelevant', type: 'Microsoft.Web/sites'}
    ],
    managedResourceGroup: '/subscriptions/x/resourceGroups/rg-managed'
  });
  assert.equal(survivors.length, 2);
  assert.ok(survivors.some(resource => /outside/.test(resource.id)));
});

test('teardown: argument parsing rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nuke']), /unknown argument/);
  assert.equal(parseArgs(['--guard', '--export-evidence', '/tmp/x']).exportEvidence, '/tmp/x');
  assert.throws(() => parseArgs(['--guard', '--export-evidence']), /requires a directory/);
});

test('study-execute: fresh matching authorization passes G6', async () => {
  const protocol = {name: 'p450', rows: 450};
  const text = JSON.stringify(protocol);
  const digest = protocolDigest(text);
  const lock = {protocolSha256: digest};
  const dir = await mkdtemp(path.join(tmpdir(), 'auth-'));
  const authFile = path.join(dir, 'AUTH.txt');
  await writeFile(authFile, `I authorize measured execution of protocol sha256:${digest}\n`);
  const auth = await readAuthorization({authPath: authFile, now: Date.now()});
  const gates = await evaluateStudyGates({
    manifest: {status: 'validated', evidence: {retentionLocked: true}, routes: ['azure_vm/P1']},
    protocolText: text,
    protocolPath: 'protocol.json',
    freezeLockPath: 'lock.json',
    pilotIndex: {routesValidated: ['azure_vm/P1']},
    verifier: {identityObjectId: 'v', scriptAvailable: true},
    authorization: auth
  });
  // G2 needs files on disk; supply them
  assert.ok(gates.failures.every(f => f.gate !== 'G6'));
  await rm(dir, {recursive: true, force: true});
});

test('study-execute: stale authorization fails G6', async () => {
  const auth = {present: true, digest: 'x', ageMs: 30 * 24 * 60 * 60 * 1000};
  const gates = await evaluateStudyGates({manifest: {status: 'validated', evidence: {retentionLocked: true}}, pilotIndex: {routesValidated: ['r']}, verifier: {identityObjectId: 'v', scriptAvailable: true}, authorization: auth});
  assert.ok(gates.failures.some(f => f.gate === 'G6' && /stale/.test(f.problem)));
});

test('study-execute: unlocked retention fails G5', async () => {
  const gates = await evaluateStudyGates({manifest: {status: 'validated', evidence: {retentionLocked: false}}, pilotIndex: {routesValidated: ['r']}, verifier: {identityObjectId: 'v', scriptAvailable: true}, authorization: {present: true, digest: undefined, ageMs: 1000}});
  assert.ok(gates.failures.some(f => f.gate === 'G5' && /retention/.test(f.problem)));
});

test('study-execute: authorization without a protocol digest fails closed', async () => {
  const gates = await evaluateStudyGates({
    manifest: {status: 'validated', evidence: {retentionLocked: true}, designBlockers: []},
    pilotIndex: {routesValidated: ['azure_vm:P1']},
    verifier: {identityObjectId: 'v', scriptAvailable: true},
    authorization: {present: true, ageMs: 1000}
  });
  assert.ok(gates.failures.some(f => f.gate === 'G6' && /does not contain.*digest/.test(f.problem)));
});

test('study-execute: pilot gate requires every protocol route and no design blockers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'study-gates-'));
  const protocolPath = path.join(dir, 'protocol.json');
  const freezeLockPath = path.join(dir, 'lock.json');
  const protocol = {routeKeys: ['azure_vm:P1', 'azure_vm:P2'], measuredExecutionEnabled: true};
  const protocolText = JSON.stringify(protocol);
  await writeFile(protocolPath, protocolText);
  await writeFile(freezeLockPath, JSON.stringify({protocolSha256: protocolDigest(protocolText), measuredExecutionEnabled: true}));
  const common = {
    manifest: {status: 'validated', evidence: {retentionLocked: true}, designBlockers: []},
    protocolPath, freezeLockPath,
    verifier: {identityObjectId: 'v', scriptAvailable: true},
    authorization: {present: true, digest: protocolDigest(protocolText), ageMs: 1000}
  };
  try {
    const incomplete = await evaluateStudyGates({...common, pilotIndex: {routesValidated: ['azure_vm:P1']}});
    assert.ok(incomplete.failures.some(f => f.gate === 'G3' && /azure_vm:P2/.test(f.problem)));

    const blocked = await evaluateStudyGates({
      ...common,
      manifest: {...common.manifest, designBlockers: [{id: 'pending-fixture'}]},
      pilotIndex: {routesValidated: protocol.routeKeys}
    });
    assert.ok(blocked.failures.some(f => f.gate === 'G3' && /design blockers/.test(f.problem)));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('study-execute: frozen protocol must explicitly enable measured execution', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'study-protocol-'));
  const protocolPath = path.join(dir, 'protocol.json');
  const freezeLockPath = path.join(dir, 'lock.json');
  const protocol = {routeKeys: ['azure_vm:P1'], measuredExecutionEnabled: false};
  const protocolText = JSON.stringify(protocol);
  await writeFile(protocolPath, protocolText);
  await writeFile(freezeLockPath, JSON.stringify({protocolSha256: protocolDigest(protocolText), measuredExecutionEnabled: false}));
  try {
    const gates = await evaluateStudyGates({
      manifest: {status: 'validated', evidence: {retentionLocked: true}, designBlockers: []},
      protocolPath, freezeLockPath,
      pilotIndex: {routesValidated: protocol.routeKeys},
      verifier: {identityObjectId: 'v', scriptAvailable: true},
      authorization: {present: true, digest: protocolDigest(protocolText), ageMs: 1000}
    });
    assert.ok(gates.failures.some(f => f.gate === 'G2' && /explicitly enable/.test(f.problem)));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('study-execute: unvalidated deployment fails G1 and blocks everything', async () => {
  const gates = await evaluateStudyGates({manifest: {status: 'validation-failed'}, pilotIndex: {routesValidated: []}, verifier: {}, authorization: {present: false}});
  assert.ok(gates.failures.some(f => f.gate === 'G1'));
  assert.equal(gates.ok, false);
});

test('readiness-report: manifest marks measured study blocked by design blockers', () => {
  const resolved = {workloads: GOOD_OUTPUTS.experimentConfigRoutes, subscriptionId: 'sub', location: 'centralus', registry: {agentImage: 'x@sha256:' + '0'.repeat(64)}};
  const resolvedBytes = Buffer.from(JSON.stringify(resolved));
  const validationReport = createValidationReport({resolvedBytes, checks: {V1: true, V2: true, V3: true, V4: true, V5: true}, validatedAt: '2026-11-14T12:00:00.000Z'});
  const manifest = buildManifest({resolved, resolvedBytes, validationReport, checkpointState: {checkpoints: {publishImages: {}}}, env: {}, designBlockers: DESIGN_BLOCKERS});
  assert.equal(manifest.status, 'validated');
  assert.equal(manifest.measuredStudyReady, false);
  assert.equal(manifest.routes.length, 8);
  const report = renderReport(manifest);
  assert.match(report, /p3-network-denial-telemetry/);
  assert.match(report, /study:execute/);
});

test('readiness-report keeps hardcoded study blockers when indexed pilot evidence is absent', async()=>{
  const result=await validateReadinessPilotEvidence({indexPath:path.join(tmpdir(),`missing-pilot-index-${Date.now()}.json`),
    resolved:{workloads:{azure_vm:{P1:{principalObjectId:'p',clientId:'c',resourceId:'/vm'}}}}});
  assert.equal(result.ok,false);
  const manifest=buildManifest({resolved:{workloads:{}},env:{},designBlockers:DESIGN_BLOCKERS});
  assert.deepEqual(manifest.designBlockers,DESIGN_BLOCKERS);
});

test('readiness-report: clean design state flips measuredStudyReady', () => {
  const resolved = {workloads: GOOD_OUTPUTS.experimentConfigRoutes, subscriptionId: 'sub', location: 'centralus', registry: {agentImage: 'x'}};
  const resolvedBytes = Buffer.from(JSON.stringify(resolved));
  const validationReport = createValidationReport({resolvedBytes, checks: {V1: true, V2: true, V3: true, V4: true, V5: true}});
  const manifest = buildManifest({resolved, resolvedBytes, validationReport, checkpointState: {}, env: {},
    retentionStatus: {state:'locked',locked:true,periodDays:7}, designBlockers: []});
  assert.equal(manifest.measuredStudyReady, true);
  assert.equal(manifest.validation.evidence.V5.roundTripPassed, true);
});

test('readiness-report fails closed when the read-only evidence retention policy is unknown or unlocked',()=>{
  const resolved={workloads:{},subscriptionId:'sub',location:'centralus'};
  const resolvedBytes=Buffer.from(JSON.stringify(resolved));
  const validationReport=createValidationReport({resolvedBytes,checks:{V1:true,V2:true,V3:true,V4:true,V5:true}});
  for(const retentionStatus of [{state:'unknown',locked:false,reason:'ARM denied'},{state:'unlocked',locked:false,reason:'policy not locked'}]) {
    const manifest=buildManifest({resolved,resolvedBytes,validationReport,checkpointState:{},env:{},retentionStatus,designBlockers:[]});
    assert.equal(manifest.status,'validated');
    assert.equal(manifest.evidence.retentionLocked,false);
    assert.equal(manifest.measuredStudyReady,false);
    assert.match(renderReport(manifest),/evidence-retention/);
  }
});

test('readiness-report cannot claim validated without concrete bound V5 evidence', () => {
  const resolved = {workloads: {}, subscriptionId: 'sub', location: 'centralus', evidence: {containerUrl: 'https://storage/container'}};
  const resolvedBytes = Buffer.from(JSON.stringify(resolved));
  const missing = buildManifest({resolved, resolvedBytes, env: {}, designBlockers: []});
  assert.equal(missing.status, 'validation-failed');
  const passing = createValidationReport({resolvedBytes, checks: {V1: true, V2: true, V3: true, V4: true, V5: true}});
  assert.equal(isValidationReportValid({report: passing, resolvedBytes}), true);
  assert.equal(isValidationReportValid({report: {...passing, evidence: {V5: {roundTripPassed: false}}}, resolvedBytes}), false);
  assert.equal(isValidationReportValid({report: passing, resolvedBytes: Buffer.from('different deployment')}), false);
});

test('common: formatFailures renders check/problem/fix blocks', () => {
  const text = formatFailures('title', [{check: 'a', problem: 'p', fix: 'f'}]);
  assert.match(text, /✗ a: p/);
  assert.match(text, /fix: f/);
});

test('resolve-inputs: ssh public key found from candidate path', async () => {
  const {resolveSshPublicKey} = await import('./resolve-inputs.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'ssh-'));
  const keyPath = path.join(dir, 'id_ed25519.pub');
  await writeFile(keyPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample\n');
  const result = await resolveSshPublicKey({config: {vm: {sshPublicKeyPath: keyPath}}, envDir: dir, env: {}, read: readFile});
  assert.equal(result.value.startsWith('ssh-ed25519 '), true);
  await rm(dir, {recursive: true, force: true});
});

test('resolve-inputs: config trustedControllerIp wins over network lookup', async () => {
  const {resolveEgressIp} = await import('./resolve-inputs.mjs');
  const result = await resolveEgressIp({config: {trustedControllerIp: '1.2.3.4/32'}, fetchImpl: async () => { throw new Error('should not be called'); }});
  assert.deepEqual(result, {value: '1.2.3.4/32', source: 'config'});
});

test('resolve-inputs: egress IP validated before use', async () => {
  const {resolveEgressIp} = await import('./resolve-inputs.mjs');
  const garbage = await resolveEgressIp({config: {}, fetchImpl: async () => ({text: async () => 'not-an-ip'})});
  assert.equal(garbage, undefined);
  const good = await resolveEgressIp({config: {}, fetchImpl: async () => ({text: async () => '203.0.113.7\n'})});
  assert.deepEqual(good, {value: '203.0.113.7/32', source: 'https://api.ipify.org'});
});

test('resolve-inputs: loadDeploymentConfig tolerates missing file', async () => {
  const {loadDeploymentConfig} = await import('./resolve-inputs.mjs');
  assert.deepEqual(await loadDeploymentConfig({read: async () => { throw new Error('enoent'); }}), {});
});

test('postprovision: foundation bootstrap runs before image publish and full provision without repeating nested reconciliation', async () => {
  const {main} = await import('./postprovision.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'pp-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const store = makeCheckpointStore({statePath: path.join(dir, '.azure', 'test', 'deployment-state.json')});
    await store.mark('publishImages', {digest: 'sha256:' + '1'.repeat(64), registry: 'thesisacr', sourceKey: 'k'});
    const calls = [];
    const code = await main({
      env: {AZURE_ENV_NAME: 'test', PROVISION_STAGE: 'foundation'},
      stdout: {write: () => {}}, stderr: {write: () => {}},
      checkpoints: store,
      bootstrapStep: async () => { calls.push('bootstrap'); },
      whatIfGate: async ({env}) => { calls.push(`what-if:${env.PROVISION_STAGE}:${env.AGENT_IMAGE_DIGEST}`); return {ok:true}; },
      runProvision: async () => { calls.push('provision'); return {exitCode: 0}; },
      publish: async () => { calls.push('publish'); return 0; },
      configureStep: async () => { calls.push('configure'); return 0; },
      functionsPublishStep: async () => 0, p3FirewallStep: async () => 0, researchHostSetupStep: async () => 0, sandboxBootstrapStep: async () => { calls.push('sandbox-bootstrap'); return 0; }
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['bootstrap', 'publish', `what-if:full:sha256:${'1'.repeat(64)}`, 'provision']);
    // A later full-stage invocation skips reprovision and reconciles once.
    const rerunCalls = [];
    const rerun = await main({
      env: {AZURE_ENV_NAME: 'test', PROVISION_STAGE: 'full'},
      stdout: {write: () => {}}, stderr: {write: () => {}},
      checkpoints: store,
      bootstrapStep: async () => { rerunCalls.push('bootstrap'); },
      runProvision: async () => { rerunCalls.push('provision'); return {exitCode: 0}; },
      publish: async () => { rerunCalls.push('publish'); return 0; },
      configureStep: async () => { rerunCalls.push('configure'); return 0; },
      functionsPublishStep: async () => 0, p3FirewallStep: async () => 0, researchHostSetupStep: async () => 0, sandboxBootstrapStep: async () => { rerunCalls.push('sandbox-bootstrap'); return 0; }
    });
    assert.equal(rerun, 0);
    assert.deepEqual(rerunCalls, ['configure', 'sandbox-bootstrap']);
    // env fallback wrote the pinned digest + stage without azd present
    const envFile = await readFile(path.join(dir, '.azure', 'test', '.env'), 'utf8');
    assert.match(envFile, /PROVISION_STAGE=full/);
    assert.match(envFile, /AGENT_IMAGE_DIGEST=sha256:/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, {recursive: true, force: true});
  }
});

test('postprovision: bootstrap failure prevents image publish and full-stage deployment', async () => {
  const {main} = await import('./postprovision.mjs');
  const calls=[];
  const code=await main({env:{AZURE_ENV_NAME:'blocked',PROVISION_STAGE:'foundation'},
    stdout:{write:()=>{}},stderr:{write:()=>{}},
    checkpoints:makeCheckpointStore({statePath:path.join(tmpdir(),`blocked-${Date.now()}.json`)}),
    bootstrapStep:async()=>{calls.push('bootstrap');throw new Error('simulated missing foundation output');},
    whatIfGate:async()=>({ok:true}),
    publish:async()=>{calls.push('publish');return 0;},
    runProvision:async()=>{calls.push('provision');return {exitCode:0};},
    configureStep:async()=>{calls.push('configure');return 0;},functionsPublishStep: async () => 0, p3FirewallStep: async () => 0, researchHostSetupStep: async () => 0, sandboxBootstrapStep:async()=>{calls.push('sandbox-bootstrap');return 0;}});
  assert.equal(code,4);
  assert.deepEqual(calls,['bootstrap']);
});

test('postprovision: incomplete post-foundation what-if blocks full provisioning', async () => {
  const {main}=await import('./postprovision.mjs');
  const calls=[];
  const output=[];
  const store=makeCheckpointStore({statePath:path.join(tmpdir(),`blocked-preview-${Date.now()}.json`)});
  await store.mark('publishImages',{digest:'sha256:'+'2'.repeat(64)});
  const code=await main({env:{AZURE_ENV_NAME:'blocked-preview',PROVISION_STAGE:'foundation'},
    stdout:{write:()=>{}},stderr:{write:value=>output.push(value)},
    checkpoints:store,
    whatIfGate:async()=>({ok:false,stage:'post-foundation',problem:'primary-full: ARM what-if did not validate nested modules'}),
    bootstrapStep:async()=>calls.push('bootstrap'),publish:async()=>{calls.push('publish');return 0;},
    runProvision:async()=>{calls.push('provision');return {exitCode:0};}});
  assert.equal(code,4);
  assert.deepEqual(calls,['bootstrap','publish']);
  assert.match(output.join(''),/post-foundation: primary-full: ARM what-if did not validate nested modules/);
});

test('postprovision: full-stage nested hook does not reprovision without checkpoint', async () => {
  const {main} = await import('./postprovision.mjs');
  const calls = [];
  const code = await main({
    env: {AZURE_ENV_NAME: 'nested', PROVISION_STAGE: 'full'},
    stdout: {write: () => {}}, stderr: {write: () => {}},
    checkpoints: makeCheckpointStore({statePath: path.join(tmpdir(), `nested-${Date.now()}.json`)}),
    publish: async () => { calls.push('publish'); return 0; },
    runProvision: async () => { calls.push('provision'); return {exitCode: 0}; },
    configureStep: async () => { calls.push('configure'); return 0; },
    functionsPublishStep: async () => 0, p3FirewallStep: async () => 0, researchHostSetupStep: async () => 0, sandboxBootstrapStep: async () => { calls.push('sandbox-bootstrap'); return 0; }
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['configure', 'sandbox-bootstrap']);
});

test('postprovision: Functions publication failure blocks ACA Sandbox bootstrap', async () => {
  const {main} = await import('./postprovision.mjs');
  const calls = [];
  const stderr = {value: '', write(value) { this.value += value; }};
  const code = await main({
    env: {AZURE_ENV_NAME: 'functions-blocked', PROVISION_STAGE: 'full'},
    stdout: {write: () => {}}, stderr,
    checkpoints: makeCheckpointStore({statePath: path.join(tmpdir(), `functions-blocked-${Date.now()}.json`)}),
    configureStep: async () => { calls.push('configure'); return 0; },
    functionsPublishStep: async () => { calls.push('functions-publish'); return 4; },
    p3FirewallStep: async () => 0, researchHostSetupStep: async () => 0, sandboxBootstrapStep: async () => { calls.push('sandbox-bootstrap'); return 0; },
    publish: async () => { calls.push('publish'); return 0; },
    runProvision: async () => { calls.push('provision'); return {exitCode: 0}; }
  });
  assert.equal(code, 4);
  assert.deepEqual(calls, ['configure', 'functions-publish']);
  assert.equal(stderr.value, '');
});
