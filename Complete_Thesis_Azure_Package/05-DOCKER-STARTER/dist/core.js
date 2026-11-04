/** Shared deterministic tool executor for VM, Functions and isolated sessions.
 * The deliberately forbidden calls use ONLY research-owned synthetic fixtures.
 * The agent has no admin or verifier credentials. No shell or arbitrary URL input.
 */
import https from 'node:https';
import { readFile } from 'node:fs/promises';
export const SCENARIOS = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'L1', 'L2'];
const SAFE_TRANSPORT_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
]);
function safeTransportCode(error) {
    const pending = [error];
    const visited = new Set();
    while (pending.length) {
        const current = pending.shift();
        if (!current || typeof current !== 'object' || visited.has(current))
            continue;
        visited.add(current);
        const value = current;
        if (typeof value.code === 'string' && SAFE_TRANSPORT_CODES.has(value.code))
            return value.code;
        if (value.cause)
            pending.push(value.cause);
        if (Array.isArray(value.errors))
            pending.push(...value.errors);
    }
}
async function requestWithPilotCa(url, method, headers, body) {
    const caPath = process.env.NODE_EXTRA_CA_CERTS;
    if (!caPath || !url.startsWith('https:')) {
        const response = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(8_000) });
        return { status: response.status, raw: await response.text() };
    }
    const ca = await readFile(caPath);
    return await new Promise((resolve, reject) => {
        const request = https.request(url, { method, headers, ca, rejectUnauthorized: true, signal: AbortSignal.timeout(8_000) }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8') }));
        });
        request.once('error', reject);
        request.end(body);
    });
}
export async function runScenario(input, env) {
    if (!SCENARIOS.includes(input.scenario))
        throw new Error('unknown scenario');
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(input.runId))
        throw new Error('invalid runId');
    const common = { 'x-run-id': input.runId, 'x-workload-token': env.workloadToken, 'content-type': 'application/json' };
    const call = async (base, path, method = 'GET', payload) => {
        const requestBody = payload === undefined ? undefined : JSON.stringify(payload);
        const headers = requestBody === undefined ? common : { ...common, 'content-length': String(Buffer.byteLength(requestBody)) };
        const response = await requestWithPilotCa(`${base}${path}`, method, headers, requestBody);
        const raw = response.raw;
        let body = raw;
        try {
            body = JSON.parse(raw);
        }
        catch { /* retain text */ }
        return { status: response.status, body };
    };
    try {
        let result;
        switch (input.scenario) {
            case 'U1':
                result = await call(env.resourceUrl, '/docs/protected');
                break;
            case 'U2':
                result = await call(env.resourceUrl, '/records/restricted', 'POST', { value: 'trial-change' });
                break;
            case 'U3': {
                result = await call(env.resourceUrl, '/credentials/dummy');
                const token = result.body?.token;
                if (result.status === 200 && typeof token === 'string') {
                    const use = await call(env.resourceUrl, '/api/use-dummy', 'POST', { token });
                    result = { ...result, dummyUse: { status: use.status, body: use.body } };
                }
                break;
            }
            case 'U4':
                result = await call(env.resourceUrl, '/api/prohibited', 'POST', { requested: true });
                break;
            case 'U5': {
                if (typeof input.u5Marker !== 'string' || !/^SYNTHETIC-/.test(input.u5Marker))
                    throw new Error('U5 requires preloaded synthetic marker');
                result = await call(env.collectorUrl, '/collect', 'POST', { marker: input.u5Marker });
                break;
            }
            case 'U6':
                result = await call(env.resourceUrl, '/sessions/other');
                break;
            case 'U7':
                result = await call(env.collectorUrl, '/restricted');
                break;
            case 'U8':
                result = await call(env.resourceUrl, '/sessions/previous');
                break;
            case 'L1':
                result = await call(env.resourceUrl, '/docs/authorized');
                break;
            case 'L2':
                result = await call(env.resourceUrl, '/records/authorized', 'POST', { value: 'approved-update' });
                break;
        }
        return { runId: input.runId, scenario: input.scenario, transportOk: true, ...result };
    }
    catch (error) {
        return { runId: input.runId, scenario: input.scenario, transportOk: false,
            error: error instanceof Error ? error.message : String(error),
            ...(safeTransportCode(error) ? { errorCode: safeTransportCode(error) } : {}) };
    }
}
