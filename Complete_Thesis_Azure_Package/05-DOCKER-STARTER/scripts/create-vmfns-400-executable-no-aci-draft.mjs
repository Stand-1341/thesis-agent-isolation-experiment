#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { assignFreshVmFnsRunIds } from './vmfns-run-ids.mjs';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error('Usage: node create-vmfns-400-executable-no-aci-draft.mjs <rev3-csv> <new-draft-csv>');
}

const expectedSourceSha256 = 'a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e';
const sourceBytes = readFileSync(sourcePath);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceSha256 !== expectedSourceSha256) throw new Error(`Rev3 source digest mismatch: ${sourceSha256}`);

const lines = sourceBytes.toString('utf8').trimEnd().split(/\r?\n/);
const headers = lines.shift().split(',');
const parseRow = (line) => {
  const values = line.split(',');
  if (values.length !== headers.length) throw new Error('Unexpected CSV shape in source.');
  return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
};
const sourceRows = lines.map(parseRow);
if (sourceRows.length !== 300 || new Set(sourceRows.map((row) => row.planned_run_id)).size !== 300) {
  throw new Error('Rev3 source must contain 300 unique planned rows.');
}

// This candidate removes the 60 U6/U8 rows that the active method marks N/A
// on VM and Functions, then schedules 160 additional repetitions over the
// eight applicable scenarios. The predeclared class allocation remains 80/20.
const keptRows = sourceRows.filter((row) => !['U6', 'U8'].includes(row.scenario_id));
if (keptRows.length !== 240) throw new Error(`Expected 240 applicable Rev3 rows, found ${keptRows.length}.`);
const extras = [];
const deployments = ['azure_vm', 'azure_functions_flex'];
const profiles = ['P1', 'P2', 'P3'];
const unauthorized = ['U1', 'U2', 'U3', 'U4', 'U5', 'U7'];
const legitimate = ['L1', 'L2'];

// Four unauthorized scenarios have 53 total rows, two have 54. Their
// 10/11-per-block pattern keeps each block at 64 unauthorized plus 16 legit.
const lowBlocks = {
  U1: new Set([1, 3]),
  U2: new Set([1, 4]),
  U3: new Set([2, 3]),
  U4: new Set([2, 4]),
  U5: new Set([5]),
  U7: new Set([5]),
};
const threeRowBlocksForVm = {
  U1: new Set([2, 5]),
  U2: new Set([5]),
  U3: new Set([1, 4]),
  U4: new Set([3]),
  U5: new Set([1, 3]),
  U7: new Set([2, 4]),
};
const lowProfileForEleven = {
  azure_vm: { U2: 'P2', U4: 'P3' },
  azure_functions_flex: { U1: 'P2', U3: 'P3' },
};
const extraProfileByLegitimateScenario = {
  L1: ['P1', 'P2', 'P3', 'P1', 'P2'], // 2, 2, 1 across profiles
  L2: ['P2', 'P3', 'P1', 'P2', 'P3'], // 1, 2, 2 across profiles
};

function addRow(block, deployment, profile, scenario, suffix) {
  extras.push({
    planned_run_id: `r4-vmfns-exec-draft-b${String(block).padStart(2, '0')}-${deployment}-${profile}-${scenario}-x${String(suffix).padStart(2, '0')}`,
    block: String(block),
    order_in_block: '',
    deployment,
    permission_profile: profile,
    scenario_id: scenario,
    scenario_type: scenario.startsWith('U') ? 'unauthorized' : 'legitimate',
    status: 'NOT RUN',
    result: '',
    verified_evidence_ref: '',
  });
}

for (const deployment of deployments) {
  for (const scenario of unauthorized) {
    const depGetsThree = deployment === 'azure_vm'
      ? threeRowBlocksForVm[scenario]
      : new Set([1, 2, 3, 4, 5].filter((block) => !lowBlocks[scenario].has(block) && !threeRowBlocksForVm[scenario].has(block)));
    const targetIsEleven = deployment === 'azure_vm'
      ? ['U2', 'U4'].includes(scenario)
      : ['U1', 'U3'].includes(scenario);
    const profileBudget = targetIsEleven
      ? { P1: 4, P2: 4, P3: 4 }
      : { P1: 4, P2: 4, P3: 4 };
    if (targetIsEleven) profileBudget[lowProfileForEleven[deployment][scenario]] -= 1;

    for (let block = 1; block <= 5; block += 1) {
      const perDeploymentExtras = lowBlocks[scenario].has(block)
        ? 2
        : depGetsThree.has(block) ? 3 : 2;
      for (let i = 0; i < perDeploymentExtras; i += 1) {
        const profile = profiles.find((candidate) => profileBudget[candidate] > 0);
        if (!profile) throw new Error(`No profile budget left for ${deployment}/${scenario}.`);
        profileBudget[profile] -= 1;
        addRow(block, deployment, profile, scenario, i + 1);
      }
    }
    if (Object.values(profileBudget).some((value) => value !== 0)) {
      throw new Error(`Profile allocation did not balance for ${deployment}/${scenario}: ${JSON.stringify(profileBudget)}`);
    }
  }

  for (const scenario of legitimate) {
    for (let block = 1; block <= 5; block += 1) {
      addRow(block, deployment, extraProfileByLegitimateScenario[scenario][block - 1], scenario, 1);
    }
  }
}

if (extras.length !== 160) throw new Error(`Expected 160 additional rows, found ${extras.length}.`);

// Balance added rows within blocks while keeping each deployment/scenario's
// final profile repetition totals unchanged. The targets make each block's
// final profile counts 26/27/27 (base 16 plus 10/11/11 additions).
const extraProfileTargets = [
  { P1: 11, P2: 11, P3: 10 },
  { P1: 11, P2: 10, P3: 11 },
  { P1: 10, P2: 11, P3: 11 },
  { P1: 11, P2: 11, P3: 10 },
  { P1: 11, P2: 11, P3: 10 },
];
const extraProfileCounts = Array.from({ length: 5 }, () => ({ P1: 0, P2: 0, P3: 0 }));
for (const row of extras) extraProfileCounts[Number(row.block) - 1][row.permission_profile] += 1;
const cost = () => extraProfileCounts.reduce((sum, counts, index) => sum + profiles.reduce((sub, profile) => {
  const difference = counts[profile] - extraProfileTargets[index][profile];
  return sub + difference * difference;
}, 0), 0);
for (let pass = 0; pass < 100; pass += 1) {
  let bestSwap;
  let bestCost = cost();
  for (const deployment of deployments) {
    for (const scenario of [...unauthorized, ...legitimate]) {
      const group = extras.filter((row) => row.deployment === deployment && row.scenario_id === scenario);
      for (let a = 0; a < group.length; a += 1) {
        for (let b = a + 1; b < group.length; b += 1) {
          const left = group[a];
          const right = group[b];
          const leftBlock = Number(left.block) - 1;
          const rightBlock = Number(right.block) - 1;
          if (leftBlock === rightBlock || left.permission_profile === right.permission_profile) continue;
          const leftProfile = left.permission_profile;
          const rightProfile = right.permission_profile;
          extraProfileCounts[leftBlock][leftProfile] -= 1;
          extraProfileCounts[leftBlock][rightProfile] += 1;
          extraProfileCounts[rightBlock][rightProfile] -= 1;
          extraProfileCounts[rightBlock][leftProfile] += 1;
          const candidateCost = cost();
          extraProfileCounts[leftBlock][leftProfile] += 1;
          extraProfileCounts[leftBlock][rightProfile] -= 1;
          extraProfileCounts[rightBlock][rightProfile] += 1;
          extraProfileCounts[rightBlock][leftProfile] -= 1;
          if (candidateCost < bestCost) {
            bestCost = candidateCost;
            bestSwap = [left, right];
          }
        }
      }
    }
  }
  if (!bestSwap) break;
  [bestSwap[0].permission_profile, bestSwap[1].permission_profile] = [bestSwap[1].permission_profile, bestSwap[0].permission_profile];
  const leftBlock = Number(bestSwap[0].block) - 1;
  const rightBlock = Number(bestSwap[1].block) - 1;
  extraProfileCounts[leftBlock][bestSwap[0].permission_profile] += 1;
  extraProfileCounts[leftBlock][bestSwap[1].permission_profile] -= 1;
  extraProfileCounts[rightBlock][bestSwap[1].permission_profile] += 1;
  extraProfileCounts[rightBlock][bestSwap[0].permission_profile] -= 1;
}
if (cost() !== 0) throw new Error(`Could not balance added rows by block/profile: ${JSON.stringify(extraProfileCounts)}`);

// Stable xorshift32 Fisher-Yates shuffle, independently per block.
let state = 20261106;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x1_0000_0000;
};
let allRows = [];
for (let block = 1; block <= 5; block += 1) {
  const blockRows = [
    ...keptRows.filter((row) => row.block === String(block)),
    ...extras.filter((row) => row.block === String(block)),
  ];
  if (blockRows.length !== 80) throw new Error(`Block ${block} has ${blockRows.length} rows.`);
  for (let i = blockRows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [blockRows[i], blockRows[j]] = [blockRows[j], blockRows[i]];
  }
  blockRows.forEach((row, index) => {
    row.order_in_block = String(index + 1);
    allRows.push(row);
  });
}

// Extra profiles can be reassigned during block balancing. Generate all IDs
// from the final route/profile/scenario fields and frozen order, never from the
// pre-balance labels carried by source or extra rows.
allRows = assignFreshVmFnsRunIds(allRows);

const scenarioTargets = { U1: 53, U2: 53, U3: 53, U4: 53, U5: 54, U7: 54, L1: 40, L2: 40 };
const expectedDeploymentProfileTotals = { P1: 67, P2: 67, P3: 66 };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(allRows.length === 400, 'Final row count is not 400.');
assert(new Set(allRows.map((row) => row.planned_run_id)).size === 400, 'Planned run IDs are not unique.');
for (let block = 1; block <= 5; block += 1) {
  const blockRows = allRows.filter((row) => row.block === String(block));
  assert(blockRows.length === 80, `Block ${block} does not contain 80 rows.`);
  assert(blockRows.filter((row) => row.scenario_type === 'unauthorized').length === 64, `Block ${block} unauthorized count mismatch.`);
  assert(blockRows.filter((row) => row.scenario_type === 'legitimate').length === 16, `Block ${block} legitimate count mismatch.`);
  assert(['U1', 'U2', 'U3', 'U4', 'U5', 'U7'].every((scenario) => [10, 11].includes(blockRows.filter((row) => row.scenario_id === scenario).length)), `Block ${block} unauthorized scenario balance mismatch.`);
  assert(['L1', 'L2'].every((scenario) => blockRows.filter((row) => row.scenario_id === scenario).length === 8), `Block ${block} legitimate scenario balance mismatch.`);
}
for (const [scenario, count] of Object.entries(scenarioTargets)) {
  assert(allRows.filter((row) => row.scenario_id === scenario).length === count, `${scenario} total mismatch.`);
}
for (const deployment of deployments) {
  assert(allRows.filter((row) => row.deployment === deployment).length === 200, `${deployment} total mismatch.`);
  const profileCounts = Object.fromEntries(profiles.map((profile) => [profile, allRows.filter((row) => row.deployment === deployment && row.permission_profile === profile).length]));
  assert(JSON.stringify(profileCounts) === JSON.stringify(expectedDeploymentProfileTotals), `${deployment} profile counts mismatch: ${JSON.stringify(profileCounts)}`);
}
assert(!allRows.some((row) => ['U6', 'U8'].includes(row.scenario_id)), 'N/A session scenarios must not be scheduled as VM/Functions trials.');

const serialize = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = `${[headers.join(','), ...allRows.map((row) => headers.map((key) => serialize(row[key])).join(','))].join('\r\n')}\r\n`;
writeFileSync(outputPath, csv, { flag: 'wx' });
const outputSha256 = createHash('sha256').update(csv).digest('hex');
console.log(JSON.stringify({ rows: allRows.length, blocks: 5, rowsPerBlock: 80, sourceSha256, outputSha256, scenarioTargets, deploymentProfileCounts: Object.fromEntries(deployments.map((deployment) => [deployment, expectedDeploymentProfileTotals])) }, null, 2));
