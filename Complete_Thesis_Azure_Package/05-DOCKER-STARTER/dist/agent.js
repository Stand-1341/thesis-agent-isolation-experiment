import { createServer } from 'node:http';
import { bodyJson, checkedString, send } from './helpers.js';
import { SCENARIOS, runScenario } from './core.js';
import { probeNetwork } from './network-probe.mjs';
const token = process.env.WORKLOAD_TOKEN;
const requestKey = process.env.TRIAL_REQUEST_KEY;
const resourceUrl = process.env.RESEARCH_URL;
const collectorUrl = process.env.COLLECTOR_URL;
const authMode = process.env.AZURE_TOKEN_MODE || 'managed';
if (!requestKey || !resourceUrl || !collectorUrl || !['managed', 'delegated'].includes(authMode) ||
    (authMode === 'delegated' && (!process.env.AZURE_BLOB_ENDPOINT || !!token || !!process.env.AZURE_CLIENT_ID)) ||
    (!token && !(process.env.AZURE_BLOB_ENDPOINT && authMode === 'delegated')))
    throw new Error('missing or invalid agent environment configuration');
const blobScenarios = new Set(['U1', 'U2', 'U3', 'U6', 'U8', 'L1', 'L2']);
let blobRunner;
let delegatedFactory;
if (process.env.AZURE_BLOB_ENDPOINT) {
    const endpoint = process.env.AZURE_BLOB_ENDPOINT;
    const { createBlobWorkload } = await import('./azure-blob-workload.mjs');
    if (authMode === 'managed') {
        const { createManagedStorageTokenProvider } = await import('./azure-managed-token.mjs');
        blobRunner = createBlobWorkload({ blobEndpoint: endpoint, getToken: createManagedStorageTokenProvider({ clientId: process.env.AZURE_CLIENT_ID || undefined }),
            dummyApiUrl: resourceUrl, dummyApiWorkloadToken: token });
    }
    else {
        const { createDelegatedStorageTokenProvider } = await import('./azure-delegated-token.mjs');
        delegatedFactory = body => {
            if (typeof body.azureAccessToken !== 'string' || typeof body.expectedPrincipalId !== 'string' || typeof body.mockWorkloadToken !== 'string')
                throw new Error('missing delegated workload credentials');
            return createBlobWorkload({ blobEndpoint: endpoint, getToken: createDelegatedStorageTokenProvider({ token: body.azureAccessToken, expectedPrincipalId: body.expectedPrincipalId }),
                dummyApiUrl: resourceUrl, dummyApiWorkloadToken: body.mockWorkloadToken });
        };
    }
}
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
    const requestPath = new URL(req.url || '/', `http://localhost:${port}`).pathname;
    if (requestPath === '/health' && req.method === 'GET')
        return send(res, 200, { ready: true });
    if (!['/run', '/network-probe', '/session-seed'].includes(requestPath) || req.method !== 'POST')
        return send(res, 404, { error: 'not found' });
    if (req.headers['x-trial-key'] !== requestKey)
        return send(res, 403, { error: 'controller authorization required' });
    try {
        if (requestPath === '/network-probe')
            return send(res, 200, await probeNetwork(`${resourceUrl}/health`, `${collectorUrl}/health`, { restrictedIp: process.env.PROBE_RESTRICTED_IP, redirectUrl: process.env.PROBE_REDIRECT_URL }));
        const body = await bodyJson(req);
        if (requestPath === '/session-seed') {
            if (authMode !== 'delegated' || !process.env.AZURE_BLOB_ENDPOINT || typeof body.azureAccessToken !== 'string' ||
                typeof body.expectedPrincipalId !== 'string' || typeof body.marker !== 'string')
                throw new Error('invalid session seed request');
            const { seedSessionBlob } = await import('./azure-session-seed.mjs');
            return send(res, 200, await seedSessionBlob({ blobEndpoint: process.env.AZURE_BLOB_ENDPOINT, runId: checkedString(body.runId, 'runId'),
                kind: checkedString(body.kind, 'kind'), marker: body.marker, azureAccessToken: body.azureAccessToken, expectedPrincipalId: body.expectedPrincipalId }));
        }
        const scenario = checkedString(body.scenario, 'scenario');
        const runId = checkedString(body.runId, 'runId');
        if (!SCENARIOS.includes(scenario))
            return send(res, 400, { error: 'unknown scenario' });
        const u5Marker = typeof body.u5Marker === 'string' ? body.u5Marker : undefined;
        const workloadToken = authMode === 'delegated' ? body.mockWorkloadToken : token;
        if (typeof workloadToken !== 'string' || !workloadToken || /[\r\n]/.test(workloadToken) ||
            (authMode === 'delegated' && (workloadToken.length < 32 || workloadToken.length > 512)))
            throw new Error('missing or invalid workload credential');
        if (blobRunner && blobScenarios.has(scenario))
            return send(res, 200, await blobRunner({ runId, scenario }));
        if (delegatedFactory && blobScenarios.has(scenario))
            return send(res, 200, await delegatedFactory(body)({ runId, scenario }));
        return send(res, 200, await runScenario({ runId, scenario: scenario, u5Marker }, { workloadToken, resourceUrl, collectorUrl }));
    }
    catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
}).listen(port, '0.0.0.0', () => console.log(`agent listening on ${port}`));
