import { createHash } from 'node:crypto';
export const CORRELATED_SCENARIOS = ['U1', 'U5', 'U6', 'U8'];
const correlatedScenarios = new Set(CORRELATED_SCENARIOS);
const safeRunId = /^[A-Za-z0-9_-]{1,150}$/;
export function isCorrelatedScenario(scenario) {
    return correlatedScenarios.has(scenario);
}
/** Stable per-run correlation for independently observed Blob and collector operations. */
export function requestIdForScenario(runId, scenario) {
    if (!isCorrelatedScenario(scenario))
        return undefined;
    if (typeof runId !== 'string' || !safeRunId.test(runId))
        throw new Error('invalid runId for request correlation');
    return `${scenario.toLowerCase()}-${createHash('sha256').update(runId, 'utf8').digest('hex')}`;
}
