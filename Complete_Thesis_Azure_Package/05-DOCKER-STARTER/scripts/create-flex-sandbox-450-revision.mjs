#!/usr/bin/env node
/** Deterministically create/check the additive Functions + Sandboxes 450-row revision. */
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SOURCE_PROTOCOL='config/protocol-450-three-arm-supported-v2.json';
const SOURCE_MATRIX='config/plan-450-three-arm-supported-v2.csv';
const PROTOCOL='config/protocol-450-flex-sandbox-supported-v3.json';
const MATRIX='config/plan-450-flex-sandbox-supported-v3.csv';
const LOCK='config/protocol-450-flex-sandbox-supported-v3-freeze-lock.json';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function buildFlexSandboxRevision({root=ROOT}={}) {
  const protocolBytes=await readFile(path.join(root,SOURCE_PROTOCOL));
  const matrixBytes=await readFile(path.join(root,SOURCE_MATRIX));
  if(sha256(protocolBytes)!=='fdb135628361b17347f91df7099d48afc25d6366803b498fae545ae9c2c5d2bc')
    throw new Error('v2 protocol digest changed; refusing to derive a new revision');
  if(sha256(matrixBytes)!=='3e9d26641b190eba202984c88234794fa480bb7ddbed2fd5ebc3188d269e40d6')
    throw new Error('v2 matrix digest changed; refusing to derive a new revision');
  const matrixText=matrixBytes.toString('utf8').replaceAll('tas450-b','tfs450-b').replaceAll('azure_container_apps_jobs','azure_functions_flex');
  const withoutCrlf=matrixText.replaceAll('\r\n','');
  if(withoutCrlf.includes('\n')||withoutCrlf.includes('\r')||!matrixText.endsWith('\r\n'))
    throw new Error('v2 matrix is not CRLF pinned');
  const nextMatrix=Buffer.from(matrixText,'utf8');
  const matrixSha256=sha256(nextMatrix);
  const protocol=JSON.parse(protocolBytes.toString('utf8'));
  protocol.revision='three-arm-flex-sandbox-450-v3';
  protocol.ownerDirection={
    authorized:true,
    reference:'2026-11-14 owner direction: deploy as fast as possible by redoing infrastructure on the fly in the spirit of the original research questions.',
    externalReviewStatus:'not_claimed',
    quotaEvidence:'az/Microsoft.App usages: one managed environment usable across the subscription; both regional two-environment requests failed ContactSupport. Functions Flex replaces Jobs uniformly on all three profiles; ACA Sandboxes retain per-group egress policy on the one existing environment.'
  };
  protocol.deployments=['azure_vm','azure_functions_flex','azure_container_apps_sandboxes'];
  protocol.deploymentKinds={azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'};
  protocol.routeKeys=protocol.routeKeys.map(key=>key.replace('azure_container_apps_jobs','azure_functions_flex'));
  protocol.rqMapping.RQ2='The same deterministic scenario inputs replayed on the three implemented configurations, reported by configuration and denying layer (resource authorization, VM/firewall, Functions Flex/firewall, sandbox egress policy).';
  protocol.u6U8Operationalization.scheduledOn=['azure_vm','azure_functions_flex','azure_container_apps_sandboxes'];
  protocol.p3NetworkEvidence={
    azure_vm:protocol.p3NetworkEvidence.azure_vm,
    azure_functions_flex:{
      evidenceSources:['azure_diagnostics_firewall'],
      distinctness:'The dedicated Functions Flex P3 delegated subnet routed through the shared firewall, with source-CIDR, destination, port and named Function-specific deny-rule attribution. ACA wildcard-storage and service-tag exceptions do not apply to this subnet.',
      requiresNoOpBaseline:true,
      pilotValidated:false
    },
    azure_container_apps_sandboxes:protocol.p3NetworkEvidence.azure_container_apps_sandboxes
  };
  protocol.matrix={
    ...protocol.matrix,
    file:'config/plan-450-flex-sandbox-supported-v3.csv',
    sha256:matrixSha256,
    orderingRule:'deterministic in every block: deployment [azure_vm, azure_functions_flex, azure_container_apps_sandboxes], then profile [P1, P2, P3], then scenario [U1, U2, U3, U4, U5, U6, U7, U8, L1, L2]; order_in_block 1-90; run IDs tfs450-b<block>-<order>-<deployment>-<profile>-<scenario>'
  };
  protocol.fullFactorialReference.note='This additive revision schedules all ten thesis scenarios on three supported Azure configurations (traditional VM, Functions Flex serverless, ACA Sandboxes) with 3 x 3 x 10 x 5 = 450 rows. Functions replaces Jobs uniformly on every profile to avoid the subscription managed-environment cap without mixing serverless substrates across permission profiles.'
  protocol.launchGates=protocol.launchGates.map(gate=>{
    if(gate.gate==='per_arm_non_counted_pilot') return {...gate,detail:'Functions Flex: publish identical digest-reviewed source, prove cold start and per-app identities, dedicated-subnet UDR traversal, named collector/restricted firewall denies, platform-egress separation and no-op baseline. Sandboxes: confirm preview data-plane token audience and region-qualified host, disk image build, egress-decision retrieval, deletion 404 readback. VM: reconcile image, routes and firewall policy with the shared agent build. Every arm additionally records azure_blob_container_namespaces fixture validation (session-a, session-b, prior-session) before U6/U8.'};
    return gate;
  });
  protocol.supersededArtifactsPreserved.push({
    file:'config/protocol-450-three-arm-supported-v2.json',
    protocolSha256:'fdb135628361b17347f91df7099d48afc25d6366803b498fae545ae9c2c5d2bc',
    matrixFile:'config/plan-450-three-arm-supported-v2.csv',
    matrixSha256:'3e9d26641b190eba202984c88234794fa480bb7ddbed2fd5ebc3188d269e40d6',
    status:'frozen_structural_superseded_for_scheduling_preserved_unchanged'
  });
  protocol.note='Additive structural revision only. The prior Jobs protocol, matrix and freeze lock remain byte-identical. All 450 planned rows are present, measuredExecutionEnabled remains false, and every deployment, isolation, verifier, fixture, pilot and owner-authorization gate remains open. A new Functions/Sandboxes pilot and measured freeze are mandatory; v2 evidence cannot be reused as v3 route proof.';
  const nextProtocol=Buffer.from(`${JSON.stringify(protocol,null,2)}\n`,'utf8');
  const protocolSha256=sha256(nextProtocol);
  const lock={
    status:'frozen_structural_launch_gated',
    protocolFile:'config/protocol-450-flex-sandbox-supported-v3.json',
    protocolSha256,
    matrixFile:'config/plan-450-flex-sandbox-supported-v3.csv',
    matrixSha256,
    evidence:'docs/AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md',
    scope:'owner-directed additive three-arm structural revision scheduling all ten thesis scenarios on azure_vm, azure_functions_flex and azure_container_apps_sandboxes (3 x 3 x 10 x 5 = 450 rows); Functions replaces Jobs uniformly on every profile after the live one-ACA-environment quota failure; U6/U8 remain scheduled and fixture-gated; no institutional approval claimed',
    measuredExecutionEnabled:false,
    note:'Exact-byte digests cover the files on disk. Structural freeze only: live identity, per-arm non-counted pilots, no-op network baseline, Functions source publication/cold start, verifier wiring, evidence retention and a fresh owner measured freeze remain open. No v2 artifact was modified.'
  };
  const nextLock=Buffer.from(`${JSON.stringify(lock,null,2)}\n`,'utf8');
  return {artifacts:{[MATRIX]:nextMatrix,[PROTOCOL]:nextProtocol,[LOCK]:nextLock},protocolSha256,matrixSha256};
}

export async function writeOrCheckFlexSandboxRevision({root=ROOT,check=false}={}) {
  const result=await buildFlexSandboxRevision({root});
  for(const [relative,bytes] of Object.entries(result.artifacts)) {
    const target=path.join(root,relative);
    const existing=await readFile(target).catch(error=>error?.code==='ENOENT'?undefined:Promise.reject(error));
    if(existing&& !existing.equals(bytes)) throw new Error(`${relative} differs from deterministic v3 content; inspect rather than overwrite`);
    if(check&&!existing) throw new Error(`${relative} is missing`);
    if(!check&&!existing) {
      await mkdir(path.dirname(target),{recursive:true});
      await writeFile(target,bytes,{flag:'wx'});
    }
  }
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const result=await writeOrCheckFlexSandboxRevision({check:process.argv.includes('--check')});
    process.stdout.write(`${JSON.stringify({protocolSha256:result.protocolSha256,matrixSha256:result.matrixSha256},null,2)}\n`);
  } catch(error) {
    process.stderr.write(`${error?.message??error}\n`);
    process.exitCode=1;
  }
}
