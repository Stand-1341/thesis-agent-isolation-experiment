#!/usr/bin/env node
/** Idempotently apply the two Functions Flex P3 firewall rule groups. */
import {pathToFileURL} from 'node:url';
import {makeAzRunner,makeStepLogger,readAzdEnv,readInfraOutputs} from './common.mjs';

const P3_FUNCTIONS_SUBNET='10.48.6.0/24';

function storageSuffix(fixtureBlobEndpoint) {
  try {
    const host=new URL(fixtureBlobEndpoint).hostname;
    const marker=host.indexOf('.blob.');
    if(marker>0) return host.slice(marker+'.blob.'.length);
  } catch {}
  throw new Error('Functions P3 firewall: fixture Blob endpoint is missing or invalid');
}

export function buildFunctionsFirewallRuleGroups({namePrefix,vaultName,storageSuffix: suffix,collectorPrivateIp,restrictedServicePrivateIp}) {
  if(typeof namePrefix!=='string'||!/^[a-z0-9][a-z0-9-]{1,19}$/.test(namePrefix))
    throw new Error('Functions P3 firewall: invalid name prefix');
  if(typeof vaultName!=='string'||!/^[a-zA-Z0-9-]{3,24}$/.test(vaultName))
    throw new Error('Functions P3 firewall: invalid vault name');
  if(typeof suffix!=='string'||!/^[a-z0-9.-]+$/i.test(suffix))
    throw new Error('Functions P3 firewall: invalid storage suffix');
  for(const [name,value] of [['collector',collectorPrivateIp],['restricted',restrictedServicePrivateIp]])
    if(typeof value!=='string'||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))
      throw new Error(`Functions P3 firewall: invalid ${name} IP`);
  const platformFqdns=[
    `${namePrefix}fnp3.blob.${suffix}`,`${namePrefix}fnp3.queue.${suffix}`,`${namePrefix}fnp3.table.${suffix}`,
    '*.store.core.windows.net',
    'login.microsoftonline.com','login.microsoft.com',`${vaultName}.vault.azure.net`
  ];
  return [
    {name:'required-functions-p3-egress',priority:150,properties:{priority:150,ruleCollections:[
      {name:'functions-p3-platform-https',ruleCollectionType:'FirewallPolicyFilterRuleCollection',priority:100,action:{type:'Allow'},rules:[{
        ruleType:'ApplicationRule',name:'functions-p3-required-fqdns',sourceAddresses:[P3_FUNCTIONS_SUBNET],
        protocols:[{protocolType:'Https',port:443}],targetFqdns:platformFqdns
      }]},
      {name:'functions-p3-platform-network',ruleCollectionType:'FirewallPolicyFilterRuleCollection',priority:110,action:{type:'Allow'},rules:[
        {ruleType:'NetworkRule',name:'functions-p3-platform-service-tags',ipProtocols:['TCP'],sourceAddresses:[P3_FUNCTIONS_SUBNET],
          destinationAddresses:['AzureKeyVault','AzureActiveDirectory','AzureFrontDoorFirstParty','AzureContainerRegistry','MicrosoftContainerRegistry','Storage'],
          destinationPorts:['443']},
        {ruleType:'NetworkRule',name:'functions-p3-azure-dns',ipProtocols:['TCP','UDP'],sourceAddresses:[P3_FUNCTIONS_SUBNET],
          destinationAddresses:['AzurePlatformDNS'],destinationPorts:['53']}
      ]}
    ]}},
    {name:'functions-p3-denied-receivers',priority:180,properties:{priority:180,ruleCollections:[{
      name:'functions-p3-named-denies',ruleCollectionType:'FirewallPolicyFilterRuleCollection',priority:100,action:{type:'Deny'},rules:[
        {ruleType:'NetworkRule',name:'functions-p3-deny-collector',ipProtocols:['TCP','UDP'],sourceAddresses:[P3_FUNCTIONS_SUBNET],
          destinationAddresses:[collectorPrivateIp],destinationPorts:['*']},
        {ruleType:'NetworkRule',name:'functions-p3-deny-restricted-service',ipProtocols:['TCP','UDP'],sourceAddresses:[P3_FUNCTIONS_SUBNET],
          destinationAddresses:[restrictedServicePrivateIp],destinationPorts:['*']}
      ]
    }]}}
  ];
}

export async function configureP3Firewall({env=process.env,az=makeAzRunner(),stdout=process.stdout,stderr=process.stderr,outputs}={}) {
  const log=makeStepLogger({stream:stdout});
  const values=await readAzdEnv(env);
  const armOutputs=outputs??await readInfraOutputs({env:values}).catch(()=>undefined);
  const functionsP3=armOutputs?.experimentConfigRoutes?.azure_functions_flex?.P3;
  if(!functionsP3) { log('p3-firewall','skipped',{note:'no Functions Flex P3 route'}); return 0; }
  const namePrefix=values.AZURE_NAME_PREFIX;
  const vaultName=armOutputs.workloadTokenVaultName;
  const resourceGroup=values.AZURE_RESOURCE_GROUP;
  if(!namePrefix||!vaultName||!resourceGroup) { stderr.write('p3-firewall: required deployment outputs are missing\n'); return 5; }
  let groups;
  try {
    groups=buildFunctionsFirewallRuleGroups({namePrefix,vaultName,storageSuffix:storageSuffix(armOutputs.fixtureBlobEndpoint),
      collectorPrivateIp:armOutputs.collectorPrivateIp,restrictedServicePrivateIp:armOutputs.restrictedServicePrivateIp});
  } catch(error) { stderr.write(`${error.message}\n`); return 5; }
  const policyName=`${namePrefix}-fw-policy`;
  try {
    for(const group of groups) {
      const url=`https://management.azure.com/subscriptions/${values.AZURE_SUBSCRIPTION_ID}/resourceGroups/${resourceGroup}`+
        `/providers/Microsoft.Network/firewallPolicies/${encodeURIComponent(policyName)}/ruleCollectionGroups/${encodeURIComponent(group.name)}?api-version=2023-09-01`;
      await az(['rest','--method','put','--url',url,'--headers','Content-Type=application/json','--body',JSON.stringify({properties:group.properties})],{json:true,timeoutMs:120000});
      log('p3-firewall','applied',{note:group.name});
    }
    return 0;
  } catch(error) {
    stderr.write(`p3-firewall: rule group update failed: ${String(error?.message??error).slice(0,240)}\n`);
    return 4;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await configureP3Firewall();
