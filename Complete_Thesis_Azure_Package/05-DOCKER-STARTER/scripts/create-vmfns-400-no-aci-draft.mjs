#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error('Usage: node create-vmfns-400-no-aci-draft.mjs <rev3-csv> <new-draft-csv>');
}

const expectedSourceSha256 = 'a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e';
const sourceBytes = readFileSync(sourcePath);
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceSha256 !== expectedSourceSha256) {
  throw new Error(`Rev3 source digest mismatch: ${sourceSha256}`);
}

const lines = sourceBytes.toString('utf8').trimEnd().split(/\r?\n/);
const headers = lines.shift().split(',');
const rows = lines.map((line) => {
  const values = line.split(',');
  if (values.length !== headers.length) throw new Error('Unexpected CSV shape in source.');
  return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
});
if (rows.length !== 300 || new Set(rows.map((row) => row.planned_run_id)).size !== 300) {
  throw new Error('Rev3 source must contain 300 unique planned rows.');
}

const scenarios = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'L1', 'L2'];
const startByDeployment = {
  azure_vm: Object.fromEntries(scenarios.map((scenario, index) => [scenario, index < 4 ? 0 : index < 7 ? 1 : 2])),
  azure_functions_flex: Object.fromEntries(scenarios.map((scenario, index) => [scenario, index < 3 ? 0 : index < 6 ? 1 : 2])),
};
const profileByIndex = ['P1', 'P2', 'P3'];
const extras = [];

for (let block = 1; block <= 5; block += 1) {
  for (const deployment of ['azure_vm', 'azure_functions_flex']) {
    for (const scenario of scenarios) {
      const profileIndex = (startByDeployment[deployment][scenario] + block - 1) % 3;
      const profile = profileByIndex[profileIndex];
      const baseCell = rows.find((row) => row.block === String(block)
        && row.deployment === deployment
        && row.permission_profile === profile
        && row.scenario_id === scenario);
      if (!baseCell) throw new Error(`Missing source cell: ${block}/${deployment}/${profile}/${scenario}`);
      const scenarioType = scenario.startsWith('U') ? 'unauthorized' : 'legitimate';
      extras.push({
        planned_run_id: `r4-vmfns-draft-b${String(block).padStart(2, '0')}-${deployment}-${profile}-${scenario}-extra`,
        block: String(block),
        order_in_block: '',
        deployment,
        permission_profile: profile,
        scenario_id: scenario,
        scenario_type: scenarioType,
        status: 'NOT RUN',
        result: '',
        verified_evidence_ref: '',
      });
    }
  }
}

// Stable xorshift32 Fisher-Yates shuffle: schedule order can be reproduced exactly.
let state = 20261105;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x1_0000_0000;
};
const allRows = [];
for (let block = 1; block <= 5; block += 1) {
  const blockRows = [
    ...rows.filter((row) => row.block === String(block)),
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

const serialize = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csv = `${[headers.join(','), ...allRows.map((row) => headers.map((key) => serialize(row[key])).join(','))].join('\r\n')}\r\n`;

const uniqueRunIds = new Set(allRows.map((row) => row.planned_run_id));
if (allRows.length !== 400 || uniqueRunIds.size !== 400) throw new Error('400-row/unique-ID check failed.');
for (let block = 1; block <= 5; block += 1) {
  const blockRows = allRows.filter((row) => row.block === String(block));
  if (blockRows.length !== 80) throw new Error(`Final block ${block} is not 80 rows.`);
  for (const scenario of scenarios) {
    if (blockRows.filter((row) => row.scenario_id === scenario).length !== 8) {
      throw new Error(`Scenario balance failed in block ${block}: ${scenario}`);
    }
  }
}

writeFileSync(outputPath, csv, { flag: 'wx' });
const outputSha256 = createHash('sha256').update(csv).digest('hex');
const counts = Object.fromEntries(['azure_vm', 'azure_functions_flex'].map((deployment) => [
  deployment,
  Object.fromEntries(profileByIndex.map((profile) => [profile, allRows.filter((row) => row.deployment === deployment && row.permission_profile === profile).length])),
]));
console.log(JSON.stringify({ rows: allRows.length, blocks: 5, rowsPerBlock: 80, sourceSha256, outputSha256, counts }, null, 2));
