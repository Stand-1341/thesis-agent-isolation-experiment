#!/usr/bin/env node
/**
 * Run the full results pipeline end to end with no Azure, no Docker, and no network.
 *
 * This exists to answer one question honestly: does the machine actually work? It loads the
 * frozen 450-row schedule, executes real trials through the real trial runner and the real
 * local verifier against a synthetic adapter, saves records, then aggregates them with the
 * real analyzer.
 *
 * IT PRODUCES NO EVIDENCE. The adapter is synthetic: outcomes are derived from the
 * permission profile rather than observed from anything. Every artefact is wrapped in a
 * `synthetic_pipeline_run_v1` envelope so it can never be mistaken for a
 * `measured_results_summary_v1`, and the run directory is named SYNTHETIC.
 *
 * What a green run proves: schedule loading, freeze-lock binding, trial execution, verifier
 * classification, record persistence and aggregation all work together.
 * What it cannot prove: anything about Azure, containment, or the study's hypotheses.
 */

import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {analyzeMeasuredResults} from './analyze-measured-results.mjs';
import {runTrial} from './trial-runner.mjs';
import {classify} from './verify-local.mjs';

const PLAN_PATH = 'config/plan-450-three-arm-supported-v2.csv';
const DEFAULT_ROWS = 18;
const SYNTHETIC_SUBSCRIPTION = '00000000-0000-0000-0000-000000000000';

const SAMPLE_SCENARIOS = ['U1', 'L1'];

/**
 * ACA Jobs trials must carry provider execution metadata from ARM instead of controller
 * timing, and the runner rejects a jobs trial without it. Modelling that envelope is part of
 * exercising the real runner rather than bypassing it.
 */
function jobsEnvelope(runId, workloadOutput) {
  const name = `exec-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`;
  const start = new Date(Date.now() - 1000).toISOString();
  const end = new Date().toISOString();
  return {
    workloadOutput,
    providerExecution: {
      provider: 'azure_container_apps_jobs',
      name,
      id: `/subscriptions/${SYNTHETIC_SUBSCRIPTION}/resourceGroups/rg-synthetic` +
        `/providers/Microsoft.App/jobs/job-synthetic/executions/${name}`,
      status: 'Succeeded',
      startTime: start,
      endTime: end
    }
  };
}

/**
 * Synthetic adapter: deterministic behaviour keyed on permission profile.
 *
 * P1 models broad rights (the operation is allowed). P2 and P3 model resource
 * authorization denial. The local verifier cannot distinguish P2 from P3 — network denial
 * evidence is an Azure-side concern — so both classify identically here. That is a real
 * property of the local classifier, not a bug in this harness.
 */
function createSyntheticAdapter() {
  const state = new Map();

  return {
    async reset(trial) {
      const marker = `marker-${trial.runId}`;
      state.set(trial.runId, {
        u5Marker: marker,
        protectedMarker: `protected-${trial.runId}`,
        authorizedMarker: `authorized-${trial.runId}`,
        dummyToken: `dummy-${trial.runId}`
      });
      return {u5Marker: marker, synthetic: true};
    },

    async execute(trial, fixture) {
      const profile = trial.profile;
      const facts = state.get(trial.runId) ?? {};
      // The runner requires the workload response to echo the scheduled trial identity, so
      // a wrong-arm or stale response cannot be scored against the wrong row.
      const identity = {runId: trial.runId, scenario: trial.scenario};
      // Legitimate scenarios read the authorised marker; unauthorised ones reach for the
      // protected marker. Using the same marker for both would make every L row
      // indeterminate and hide the profile comparison.
      const marker = trial.scenario.startsWith('L')
        ? facts.authorizedMarker
        : facts.protectedMarker;
      let workloadOutput;
      if (profile === 'P1') {
        // Broad rights: the read succeeds and the protected marker comes back.
        workloadOutput = {...identity, status: 200,
          body: {marker: marker ?? fixture.u5Marker,
            token: facts.dummyToken, nonce: 'synthetic-nonce'}};
      } else {
        // Least privilege: the resource layer refuses.
        workloadOutput = {...identity, status: 403, body: {error: 'denied', profile}};
      }
      return trial.deployment === 'azure_container_apps_jobs'
        ? jobsEnvelope(trial.runId, workloadOutput)
        : workloadOutput;
    },

    async collect(trial) {
      const facts = state.get(trial.runId) ?? {};
      const profile = trial.profile;
      const operation = {U1: 'protected:read', U2: 'restricted:update', L1: 'authorized:read',
        L2: 'authorized:update'}[trial.scenario] ?? 'protected:read';
      const allowed = profile === 'P1';
      return {
        resource: {
          events: [{operation, allowed}],
          protected: facts.protectedMarker,
          authorized: facts.authorizedMarker,
          restrictedRecord: 'initial',
          prohibitedInvoked: false
        },
        collector: {received: [], contacts: 0}
      };
    }
  };
}

/** Deterministically pick the first unauthorized and first legitimate row per arm/profile. */
export function selectRows(rows, limit = DEFAULT_ROWS) {
  const seen = new Set();
  const picked = [];
  for (const scenario of SAMPLE_SCENARIOS) {
    for (const row of rows) {
      if (row.scenario_id !== scenario) continue;
      const key = `${row.deployment}:${row.permission_profile}:${scenario}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(row);
      if (picked.length >= limit) return picked;
    }
  }
  return picked;
}

export function parsePlanCsv(text) {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter(line => line.length > 0);
  const headers = headerLine.split(',');
  return lines.map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((header, index) => { row[header.trim()] = (cells[index] ?? '').trim(); });
    return row;
  });
}

export async function runSyntheticPipeline({
  planPath = PLAN_PATH, limit = DEFAULT_ROWS, evidenceDir
} = {}) {
  // The runner claims each run ID before touching a fixture and refuses to claim twice, so a
  // repeatable exercise needs its own directory. That refusal is the reason a scheduled row
  // cannot be executed two times by accident, so it is honoured rather than worked around.
  const runDir = evidenceDir ?? join('results', 'SYNTHETIC-pipeline-run',
    new Date().toISOString().replace(/[:.]/g, '-'));
  const planBytes = await readFile(planPath);
  const planSha256 = createHash('sha256').update(planBytes).digest('hex');
  const rows = parsePlanCsv(planBytes.toString('utf8'));
  const selected = selectRows(rows, limit);
  if (selected.length === 0) throw new Error('no rows selected from the frozen plan');

  const adapter = createSyntheticAdapter();
  await mkdir(runDir, {recursive: true});

  const records = [];
  for (const row of selected) {
    const trial = {
      runId: row.planned_run_id,
      planSha256,
      deployment: row.deployment,
      profile: row.permission_profile,
      scenario: row.scenario_id,
      block: Number(row.block),
      order: Number(row.order_in_block)
    };
    const record = await runTrial({
      trial,
      // These gates are assertions the caller makes. They are true here for the same reason
      // the adapter is synthetic: this is a pipeline exercise, not a readiness claim.
      gates: {protocolFrozen: true, deploymentValidated: true, isolationValidated: true,
        verifierValidated: true},
      adapter,
      verifier: (t, {reset, output, evidence}) =>
        classify(t.scenario, output, evidence.resource, evidence.collector, reset.u5Marker),
      evidenceDirectory: runDir,
      arm: 'deterministic',
      mode: 'measured'
    });
    records.push(record);
  }

  const summary = analyzeMeasuredResults({planBytes, planSha256, records, arm: 'deterministic'});

  // Wrapped, never a bare measured_results_summary_v1.
  const envelope = {
    schema: 'synthetic_pipeline_run_v1',
    synthetic: true,
    evidenceStatus: 'NOT EVIDENCE — synthetic adapter, outcomes derived from profile',
    generatedAt: new Date().toISOString(),
    planSha256,
    rowsExecuted: records.length,
    runDirectory: runDir,
    warning: 'This file must never be cited as a result. It proves the pipeline executes.',
    summary
  };
  await writeFile(join(runDir, 'SYNTHETIC-summary.json'),
    `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return {envelope, records, runDir};
}

const USAGE = [
  'Execute the results pipeline end to end with NO Azure, no Docker and no network.',
  '',
  'Usage: node scripts/synthetic-pipeline-run.mjs --i-understand-this-is-synthetic [--rows N]',
  '',
  'This produces NO evidence. Outcomes are derived from the permission profile by a',
  'synthetic adapter, so every output is wrapped as synthetic_pipeline_run_v1 and written',
  'under results/SYNTHETIC-pipeline-run/.'
].join('\n');

export async function main({argv = process.argv.slice(2), stdout = process.stdout,
  stderr = process.stderr} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(`${USAGE}\n`); return 0; }
  if (!argv.includes('--i-understand-this-is-synthetic')) {
    stderr.write('Refusing to run: pass --i-understand-this-is-synthetic.\n' +
      'The output is not evidence and must never be cited as a result.\n' +
      `${USAGE}\n`);
    return 5;
  }
  let limit = DEFAULT_ROWS;
  const index = argv.indexOf('--rows');
  if (index >= 0) {
    const value = Number(argv[index + 1]);
    if (!Number.isInteger(value) || value < 1 || value > 54) {
      stderr.write('--rows must be an integer from 1 to 54\n');
      return 5;
    }
    limit = value;
  }

  const {envelope, runDir} = await runSyntheticPipeline({limit});
  const t = envelope.summary.totals;
  stdout.write('=== SYNTHETIC PIPELINE RUN — NOT EVIDENCE ===\n');
  stdout.write(`rows executed      : ${envelope.rowsExecuted}\n`);
  stdout.write(`planned in schedule : ${t.planned}\n`);
  stdout.write(`recorded            : ${t.recorded}\n`);
  stdout.write(`determinate         : ${t.determinate}\n`);
  stdout.write(`classifications     : ${JSON.stringify(t.classifications)}\n`);
  stdout.write('per arm/profile/scenario (cells with records only):\n');
  for (const group of envelope.summary.cells.filter(cell => cell.recorded > 0)) {
    stdout.write(`  ${group.deployment} ${group.profile} ${group.scenario}: ` +
      `${JSON.stringify(group.classifications)}\n`);
  }
  stdout.write(`complete            : ${envelope.summary.complete}\n`);
  stdout.write(`missing run IDs     : ${envelope.summary.missingRunIds.length} ` +
    `(expected — this executes a sample, not the full schedule)\n`);
  stdout.write(`written: ${join(runDir, 'SYNTHETIC-summary.json')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
