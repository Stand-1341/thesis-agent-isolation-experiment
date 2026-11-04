import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const ACI_DRAFT_SCENARIOS = Object.freeze(['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2']);
export const ACI_DRAFT_HEADER = 'planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref';
const UINT32_RANGE = 0x1_0000_0000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function randomIndex(seed, block, upperExclusive, state) {
  const limit = UINT32_RANGE - (UINT32_RANGE % upperExclusive);
  while (true) {
    const bytes = createHash('sha256').update(`${seed}|${block}|${state.counter++}`, 'utf8').digest();
    const value = bytes.readUInt32BE(0);
    if (value < limit) return value % upperExclusive;
  }
}

/** Five reproducible, independently shuffled blocks; no Azure or runner imports. */
export function generateAciP1DraftSchedule(seed) {
  if (typeof seed !== 'string' || !/^[a-z0-9][a-z0-9-]{5,80}$/i.test(seed)) throw new Error('invalid ACI draft randomization seed');
  const rows = [];
  for (let block = 1; block <= 5; block++) {
    const scenarios = [...ACI_DRAFT_SCENARIOS];
    const state = { counter: 0 };
    for (let i = scenarios.length - 1; i > 0; i--) {
      const j = randomIndex(seed, block, i + 1, state);
      [scenarios[i], scenarios[j]] = [scenarios[j], scenarios[i]];
    }
    scenarios.forEach((scenario, index) => rows.push({
      planned_run_id: `pilot-aci-p1-b${String(block).padStart(2,'0')}-${scenario.toLowerCase()}-r1`,
      block: String(block),
      order_in_block: String(index + 1),
      deployment: 'azure_container_instances',
      permission_profile: 'P1',
      scenario_id: scenario,
      scenario_type: scenario.startsWith('U') ? 'unauthorized' : 'legitimate',
      status: 'NOT RUN',
      result: '',
      verified_evidence_ref: '',
    }));
  }
  return Buffer.from(`${ACI_DRAFT_HEADER}\n${rows.map(row=>Object.values(row).join(',')).join('\n')}\n`, 'utf8');
}

function parseDraftCsv(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('ACI draft schedule must be supplied as bytes');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('ACI draft schedule is not valid UTF-8'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/['"\0]/.test(text)) throw new Error('ACI draft CSV must use the simple unquoted format');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== ACI_DRAFT_HEADER) throw new Error('ACI draft schedule header mismatch');
  const keys = ACI_DRAFT_HEADER.split(',');
  return lines.map((line, index) => {
    const values = line.split(',');
    if (values.length !== keys.length || values.some(value=>value.includes('\r'))) throw new Error(`invalid ACI draft row ${index + 1}`);
    return Object.fromEntries(keys.map((key,i)=>[key,values[i]]));
  });
}

/**
 * Validate integrity and full one-cell shape. This draft is deliberately never
 * runnable: U6/U8 live Azure validation and method approval are hard blockers.
 */
export function validateAciP1DraftSchedule({bytes, protocol}) {
  const draft=protocol?.status==='draft_not_approved' && protocol?.runPermitted===false;
  const approved=protocol?.status==='approved_for_non_counted_pilot' && protocol?.runPermitted===true &&
    protocol?.pendingScenarioAnalogs?.U6?.status==='validated' && protocol?.pendingScenarioAnalogs?.U8?.status==='validated';
  if ((!draft && !approved) || protocol?.countedAsStudyTrials !== false)
    throw new Error('ACI schedule metadata must be either explicitly blocked draft or explicitly approved non-counted pilot');
  if (protocol.deployment !== 'azure_container_instances' || protocol.profile !== 'P1' ||
      protocol.trials !== 50 || protocol.blocks !== 5 || protocol.scenariosPerBlock !== 10)
    throw new Error('ACI draft protocol must describe one P1 cell with 50 rows in five blocks');
  const pending=['unimplemented','prototype_integrated_not_azure_validated'];
  if (draft && (!pending.includes(protocol.pendingScenarioAnalogs?.U6?.status) || !pending.includes(protocol.pendingScenarioAnalogs?.U8?.status)))
    throw new Error('ACI draft U6/U8 analogs must remain explicitly unvalidated');
  if (approved && (!protocol.pendingScenarioAnalogs.U6.evidenceReference || !protocol.pendingScenarioAnalogs.U8.evidenceReference))
    throw new Error('ACI approved U6/U8 analogs require evidence references');
  const actualHash = sha256(bytes);
  if (!/^[a-f0-9]{64}$/.test(protocol.scheduleSha256 || '') || actualHash !== protocol.scheduleSha256)
    throw new Error('ACI draft schedule digest mismatch');

  const rows = parseDraftCsv(bytes);
  if (rows.length !== 50) throw new Error(`ACI draft schedule must contain 50 rows; got ${rows.length}`);
  const expectedBytes = generateAciP1DraftSchedule(protocol.seed);
  if (!expectedBytes.equals(bytes)) throw new Error('ACI draft schedule does not match its recorded seed and shuffle algorithm');
  const ids = new Set();
  const byBlock = new Map();
  for (const row of rows) {
    const block = Number(row.block);
    const order = Number(row.order_in_block);
    if (!Number.isInteger(block) || block < 1 || block > 5 || !Number.isInteger(order) || order < 1 || order > 10)
      throw new Error('invalid ACI draft block/order');
    if (!/^pilot-aci-p1-b\d{2}-(?:u[1-8]|l[12])-r1$/.test(row.planned_run_id) || ids.has(row.planned_run_id))
      throw new Error('ACI draft IDs must be unique pilot-aci-p1 IDs');
    ids.add(row.planned_run_id);
    if (row.deployment !== 'azure_container_instances' || row.permission_profile !== 'P1') throw new Error('ACI draft row has wrong deployment/profile');
    if (!ACI_DRAFT_SCENARIOS.includes(row.scenario_id) || row.scenario_type !== (row.scenario_id.startsWith('U')?'unauthorized':'legitimate'))
      throw new Error('invalid ACI draft scenario/type');
    if (row.status !== 'NOT RUN' || row.result || row.verified_evidence_ref) throw new Error('ACI draft schedule must remain untouched');
    const cells = byBlock.get(block) ?? [];
    cells.push({order,scenario:row.scenario_id});
    byBlock.set(block,cells);
  }
  for (let block=1; block<=5; block++) {
    const cells = byBlock.get(block);
    if (!cells || cells.length !== 10) throw new Error(`ACI draft block ${block} must contain 10 rows`);
    if (new Set(cells.map(cell=>cell.scenario)).size !== 10) throw new Error(`ACI draft block ${block} must contain each scenario exactly once`);
    if (cells.some((cell,index)=>cell.order!==index+1)) throw new Error(`ACI draft block ${block} order must be contiguous`);
  }
  return {
    status: approved ? 'approved_non_counted_pilot' : 'draft_blocked_pending_method_approval_and_u6_u8_azure_validation',
    runnable: approved,
    countedAsStudyTrials: false,
    rows: 50,
    blocks: 5,
    rowsPerBlock: 10,
    unauthorized: 40,
    legitimate: 10,
    sha256: actualHash,
    blockers: approved ? [] : protocol.blockers,
  };
}

async function main() {
  const protocolPath = new URL('../config/aci-p1-pilot-draft.json', import.meta.url);
  const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
  const schedulePath = new URL(`../../${protocol.scheduleFile}`, import.meta.url);
  if (process.argv.includes('--write-draft')) {
    const bytes = generateAciP1DraftSchedule(protocol.seed);
    await writeFile(schedulePath, bytes, { flag: 'w' });
    process.stdout.write(`${JSON.stringify({path:fileURLToPath(schedulePath),sha256:sha256(bytes),rows:50,written:true})}\n`);
    return;
  }
  const bytes = await readFile(schedulePath);
  process.stdout.write(`${JSON.stringify(validateAciP1DraftSchedule({bytes,protocol}),null,2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
