import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPreflightFacts, evaluatePreflight, requestedJobsRegions} from './preflight.mjs';

const argsOf = calls => calls.map(call => call.args);

test('quota evaluation requires requested vCPU headroom, not a VM count', () => {
  const result = evaluatePreflight({subscription: {state: 'Enabled'}, rolePermissions: [
    {actions: ['*']}
  ], providers: {
    'Microsoft.App': 'Registered', 'Microsoft.Compute': 'Registered', 'Microsoft.Network': 'Registered',
    'Microsoft.Storage': 'Registered', 'Microsoft.ManagedIdentity': 'Registered',
    'Microsoft.ContainerRegistry': 'Registered', 'Microsoft.Monitor': 'Registered'
  }, regionAvailable: true, quota: {vmFamily: 'Standard FASv7 Family', vmFamilyLimit: 8, vmFamilyUsed: 4, vmNeeded: 8},
  skuRestricted: [], existingVnetPrefixes: [], skipBudget: true});
  assert.ok(result.failures.some(failure => failure.check === 'quota' && /headroom is 4 vCPUs, deployment needs 8/.test(failure.problem)));
});

test('regional total core quota can be the limiting quota', () => {
  const result = evaluatePreflight({subscription: {state: 'Enabled'}, rolePermissions: [{actions: ['*']}], providers: {
    'Microsoft.App': 'Registered', 'Microsoft.Compute': 'Registered', 'Microsoft.Network': 'Registered',
    'Microsoft.Storage': 'Registered', 'Microsoft.ManagedIdentity': 'Registered',
    'Microsoft.ContainerRegistry': 'Registered', 'Microsoft.Monitor': 'Registered'
  }, regionAvailable: true, quota: {vmFamilyLimit: 20, vmFamilyUsed: 0, regionalCoreLimit: 5, regionalCoreUsed: 2, vmNeeded: 4},
  skuRestricted: [], existingVnetPrefixes: [], skipBudget: true});
  assert.ok(result.failures.some(failure => failure.check === 'quota' && /regional total core quota headroom is 3 vCPUs, deployment needs 4/.test(failure.problem)));
});

test('collector queries exact SKU and family usage; inherited assignments keep policy result unknown', async () => {
  const calls = [];
  const az = async args => {
    calls.push({args});
    const key = args.slice(0, 2).join(' ');
    if (key === 'account show') return {state: 'Enabled'};
    if (key === 'ad signed-in-user') return 'principal';
    if (key === 'role assignment list') return [];
    if (key === 'provider show') return 'Registered';
    if (key === 'account list-locations') return ['centralus'];
    if (key === 'vm list-skus') return [{name: 'Standard_F1as_v7', family: 'StandardFasv7Family', locations: ['centralus'], restrictions: [], capabilities: [{name: 'vCPUs', value: '1'}, {name: 'CpuArchitectureType', value: 'x64'}]}];
    if (key === 'vm list-usage') return [{name: {value: 'StandardFasv7Family'}, localName: 'Standard FASv7 Family vCPUs', limit: 10, currentValue: 0}, {name: {value: 'StandardFasv7Family'}, localName: 'Standard FASv7 Family Cores', limit: 10, currentValue: 0}, {name: {value: 'cores'}, localName: 'Total Regional vCPUs', limit: 10, currentValue: 0}];
    if (key === 'vm list') return [{size: 'Standard_F1as_v7', location: 'centralus', resourceGroup: 'study-rg'}];
    if (key === 'policy assignment') return [{name: 'inherited-policy'}];
    if (key === 'rest --method') return args.some(value => String(value).includes('/locations?')) ? {value:[{name:'centralus'}]} : {value: []};
    if (key === 'network vnet list' || key === 'consumption budget') return [];
    return [];
  };
  const facts = await collectPreflightFacts({az, env: {AZURE_SUBSCRIPTION_ID: 'sub', AZURE_LOCATION: 'centralus', VM_COUNT: '2'}, resourceGroup: 'study-rg'});
  const callsArgs = argsOf(calls);
  assert.ok(callsArgs.some(args => args.includes('--size') && args.includes('Standard_F1as_v7')));
  assert.equal(facts.quota.vmFamily, 'Standard FASv7 Family vCPUs');
  assert.equal(facts.regionAvailable, true);
  assert.equal(facts.quota.vmNeeded, 1);
  assert.equal(facts.quota.regionalCoreLimit, 10);
  assert.equal(facts.vmSkuVcpus, 1);
  assert.equal(facts.vmSkuArchitecture, 'x64');
  assert.equal(facts.currentRegionalVmCount, 1);
  assert.equal(facts.currentStudyVmCount, 1);
  assert.equal(facts.vmQuotaVerified, true);
  assert.equal(facts.skuRestricted.length, 0);
  assert.equal(facts.skuRestrictionsVerified, false);
  assert.ok(callsArgs.some(args => args.includes('--disable-scope-strict-match')));
});

test('SKU or quota lookup failures remain unverified', async () => {
  const az = async args => {
    if (args[0] === 'account' && args[1] === 'show') return {state: 'Enabled'};
    if (args[0] === 'ad') return 'principal';
    if (args[0] === 'role') return [];
    if (args[0] === 'provider') return 'Registered';
    if (args[0] === 'account' && args[1] === 'list-locations') return ['centralus'];
    if (args[0] === 'network' || args[0] === 'consumption') return [];
    throw new Error('read failed');
  };
  const facts = await collectPreflightFacts({az, env: {AZURE_SUBSCRIPTION_ID: 'sub'}, resourceGroup: undefined});
  assert.equal(facts.skuAvailable, false);
  assert.equal(facts.skuRestrictionsVerified, false);
  assert.equal(facts.vmQuotaVerified, false);
  assert.equal(facts.currentRegionalVmCount, undefined);
});

test('explicit split Jobs region assignment requests one managed environment in each region', async()=>{
  const regions={azure_container_apps_jobs:{P1:'centralus',P2:'centralus',P3:'westus2'}};
  assert.deepEqual(requestedJobsRegions(JSON.stringify(regions)),['centralus','westus2']);
  const calls=[];
  const az=async args=>{
    calls.push(args);
    if(args[0]==='account'&&args[1]==='show') return {state:'Enabled'};
    if(args[0]==='ad') return 'principal';
    if(args[0]==='role') return [];
    if(args[0]==='provider') return 'Registered';
    if(args[0]==='account'&&args[1]==='list-locations') return ['centralus','westus2'];
    if(args[0]==='vm'&&args[1]==='list-skus') return [{name:'Standard_F1as_v7',family:'StandardFasv7Family',locations:['centralus'],restrictions:[],capabilities:[{name:'vCPUs',value:'1'},{name:'CpuArchitectureType',value:'x64'}]}];
    if(args[0]==='vm'&&args[1]==='list-usage') return [{name:{value:'StandardFasv7Family'},localName:'Standard FASv7 Family vCPUs',limit:10,currentValue:0},{name:{value:'cores'},localName:'Total Regional vCPUs',limit:10,currentValue:0}];
    if(args[0]==='vm'&&args[1]==='list') return [];
    if(args[0]==='rest'&&args[1]==='--method') {
      const url=args.find(value=>String(value).includes('/providers/Microsoft.App/locations/'));
      if(!url) return {value:[{name:'centralus'},{name:'westus2'}]};
      const location=url?.match(/locations\/([^/]+)\//)?.[1];
      return {value:[{name:{value:'ManagedEnvironmentCount'},limit:2,currentValue:1,location}]};
    }
    if(args[0]==='network'||args[0]==='consumption') return [];
    return [];
  };
  regions.azure_vm={P1:'centralus',P2:'centralus',P3:'westus2'};
  const facts=await collectPreflightFacts({az,env:{AZURE_SUBSCRIPTION_ID:'sub',AZURE_LOCATION:'centralus',SERVERLESS_RUNTIME:'aca_jobs',AZURE_ROUTE_REGIONS:JSON.stringify(regions),P3_REGION_LOCATION:'westus2'},resourceGroup:undefined});
  assert.equal(facts.quota.appManagedEnvironmentsNeeded,1);
  assert.deepEqual(facts.quota.appManagedEnvironmentByRegion,{centralus:{limit:2,used:1,needed:1},westus2:{limit:2,used:1,needed:1}});
  assert.ok(!facts.failures?.some(failure=>failure.check==='region'&&failure.problem.includes('not integrated into infra/main')));
  assert.ok(!facts.failures?.some(failure=>failure.problem.includes('requires explicit reviewed shared-service and private-endpoint return route tables')));
  assert.equal(facts.vnetInventoryVerified,true);
  assert.equal(calls.filter(args=>args[0]==='rest'&&args.some(value=>String(value).includes('/providers/Microsoft.App/locations/'))).length,2);
  const evaluated=evaluatePreflight({subscription:{state:'Enabled'},rolePermissions:[{actions:['*']}],providers:{},regionAvailable:true,
    quota:{appManagedEnvironmentByRegion:{centralus:{limit:2,used:1},westus2:{limit:1,used:1}}},skipBudget:true});
  assert.ok(evaluated.failures.some(item=>item.problem.includes('headroom is 0 in westus2')));
});

test('split Sandbox routes use the integrated profile-region topology without a stale adapter blocker',async()=>{
  const regions={azure_container_apps_sandboxes:{P1:'centralus',P2:'centralus',P3:'westus2'}};
  const az=async args=>{
    if(args[0]==='account'&&args[1]==='show') return {state:'Enabled'};
    if(args[0]==='ad') return 'principal';
    if(args[0]==='role') return [];
    if(args[0]==='provider') return 'Registered';
    if(args[0]==='vm'&&args[1]==='list-skus') return [{name:'Standard_F1as_v7',family:'StandardFasv7Family',locations:['centralus'],restrictions:[],capabilities:[{name:'vCPUs',value:'1'},{name:'CpuArchitectureType',value:'x64'}]}];
    if(args[0]==='vm'&&args[1]==='list-usage') return [{name:{value:'StandardFasv7Family'},localName:'Standard FASv7 Family vCPUs',limit:10,currentValue:0},{name:{value:'cores'},localName:'Total Regional vCPUs',limit:10,currentValue:0}];
    if(args[0]==='vm'&&args[1]==='list') return [];
    if(args[0]==='rest'&&args[1]==='--method') {
      const url=args.find(value=>String(value).includes('/providers/Microsoft.App/locations/'));
      if(!url) return {value:[{name:'centralus'},{name:'westus2'}]};
      const region=url.match(/locations\/([^/]+)\//)?.[1];
      return {value:[{name:{value:'ManagedEnvironmentCount'},limit:2,currentValue:1,location:region}]};
    }
    if(args[0]==='network'||args[0]==='consumption') return [];
    return [];
  };
  const facts=await collectPreflightFacts({az,env:{AZURE_SUBSCRIPTION_ID:'sub',AZURE_LOCATION:'centralus',AZURE_ROUTE_REGIONS:JSON.stringify(regions)},resourceGroup:undefined});
  assert.ok(!facts.failures?.some(failure=>failure.check==='region'&&/Sandbox routes span regions/.test(failure.problem)));
});

test('preflight fails closed when VNet inventory is missing and requires deployed providers',()=>{
  const result=evaluatePreflight({subscription:{state:'Enabled'},rolePermissions:[{actions:['*']}],providers:{},regionAvailable:true,
    existingVnetPrefixes:[],vnetInventoryVerified:false,skipBudget:true});
  assert.ok(result.failures.some(item=>item.check==='address-space'&&item.problem.includes('inventory could not be verified')));
  for(const provider of ['Microsoft.KeyVault','Microsoft.OperationalInsights','Microsoft.Insights'])
    assert.ok(result.failures.some(item=>item.check==='providers'&&item.problem.includes(provider)));
});
