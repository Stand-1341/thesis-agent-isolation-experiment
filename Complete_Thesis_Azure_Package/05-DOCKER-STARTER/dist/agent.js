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
let managedGetBlobToken;
if (process.env.AZURE_BLOB_ENDPOINT) {
    const endpoint = process.env.AZURE_BLOB_ENDPOINT;
    const { createBlobWorkload } = await import('./azure-blob-workload.mjs');
    if (authMode === 'managed') {
        const { createManagedStorageTokenProvider } = await import('./azure-managed-token.mjs');
        managedGetBlobToken = createManagedStorageTokenProvider({ clientId: process.env.AZURE_CLIENT_ID || undefined });
        blobRunner = createBlobWorkload({ blobEndpoint: endpoint, getToken: managedGetBlobToken,
            blobResourceId: process.env.THESIS_BLOB_RESOURCE_ID, expectedPrincipalId: process.env.AZURE_PRINCIPAL_OBJECT_ID,
            expectedClientId: process.env.AZURE_CLIENT_ID,
            dummyApiUrl: resourceUrl, dummyApiWorkloadToken: token });
    }
    else {
        const { createDelegatedStorageTokenProvider } = await import('./azure-delegated-token.mjs');
        delegatedFactory = body => {
            if (typeof body.azureAccessToken !== 'string' || typeof body.expectedPrincipalId !== 'string' || typeof body.mockWorkloadToken !== 'string' ||
                (body.expectedClientId !== undefined && typeof body.expectedClientId !== 'string'))
                throw new Error('missing delegated workload credentials');
            return createBlobWorkload({ blobEndpoint: endpoint, getToken: createDelegatedStorageTokenProvider({ token: body.azureAccessToken, expectedPrincipalId: body.expectedPrincipalId }),
                blobResourceId: process.env.THESIS_BLOB_RESOURCE_ID, expectedPrincipalId: body.expectedPrincipalId, expectedClientId: body.expectedClientId,
                dummyApiUrl: resourceUrl, dummyApiWorkloadToken: body.mockWorkloadToken });
        };
    }
}
function checkedRequestId(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 100 || !/^[A-Za-z0-9_-]+$/.test(value))
        throw new Error('invalid request ID');
    return value;
}
function checkedFingerprint(value) {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value))
        throw new Error('invalid marker fingerprint');
    return value;
}
function checkedEtag(value) {
    if (typeof value !== 'string' || !/^"[^"\r\n]{1,196}"$/.test(value))
        throw new Error('invalid Blob ETag');
    return value;
}
function rejectCredentialFields(body) {
    if (['azureAccessToken', 'accessToken', 'token', 'expectedPrincipalId', 'principalId'].some(key => Object.hasOwn(body, key)))
        throw new Error('credentials and principal IDs are never accepted from session request bodies');
}
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
    // Parsing the request target can throw on a malformed one. It used to happen
    // outside any try, in an async handler, where the rejection is unhandled and
    // Node exits the process — one malformed unauthenticated request killed the
    // workload mid-trial.
    let requestPath;
    try {
        requestPath = new URL(req.url || '/', `http://localhost:${port}`).pathname;
    }
    catch {
        return send(res, 400, { error: 'invalid request target' });
    }
    if (requestPath === '/health' && req.method === 'GET')
        return send(res, 200, { ready: true });
    if (!['/run', '/network-probe', '/session-seed', '/session-delete'].includes(requestPath) || req.method !== 'POST')
        return send(res, 404, { error: 'not found' });
    if (req.headers['x-trial-key'] !== requestKey)
        return send(res, 403, { error: 'controller authorization required' });
    try {
        if (requestPath === '/network-probe')
            return send(res, 200, await probeNetwork(`${resourceUrl}/health`, `${collectorUrl}/health`, { restrictedIp: process.env.PROBE_RESTRICTED_IP, redirectUrl: process.env.PROBE_REDIRECT_URL }));
        const body = await bodyJson(req);
        if (requestPath === '/session-seed') {
            const { seedSessionBlob } = await import('./azure-session-seed.mjs');
            const runId = checkedString(body.runId, 'runId'), kind = checkedString(body.kind, 'kind');
            if (typeof body.marker !== 'string')
                throw new Error('invalid session seed request');
            if (authMode === 'delegated') {
                if (!process.env.AZURE_BLOB_ENDPOINT || typeof body.azureAccessToken !== 'string' || typeof body.expectedPrincipalId !== 'string')
                    throw new Error('invalid delegated session seed request');
                return send(res, 200, await seedSessionBlob({ blobEndpoint: process.env.AZURE_BLOB_ENDPOINT, runId, kind,
                    marker: body.marker, azureAccessToken: body.azureAccessToken, expectedPrincipalId: body.expectedPrincipalId }));
            }
            rejectCredentialFields(body);
            if (!process.env.AZURE_BLOB_ENDPOINT || !process.env.THESIS_BLOB_RESOURCE_ID || !process.env.AZURE_PRINCIPAL_OBJECT_ID || !managedGetBlobToken)
                throw new Error('managed session seed is not configured for this attached identity');
            const requestId = checkedRequestId(body.requestId);
            const result = await seedSessionBlob({ blobEndpoint: process.env.AZURE_BLOB_ENDPOINT, runId, kind, marker: body.marker, requestId,
                expectedPrincipalId: process.env.AZURE_PRINCIPAL_OBJECT_ID, expectedResourceId: process.env.THESIS_BLOB_RESOURCE_ID,
                expectedClientId: process.env.AZURE_CLIENT_ID,
                getManagedToken: managedGetBlobToken });
            return send(res, 200, result);
        }
        if (requestPath === '/session-delete') {
            rejectCredentialFields(body);
            if (authMode !== 'managed' || !process.env.AZURE_BLOB_ENDPOINT || !process.env.THESIS_BLOB_RESOURCE_ID ||
                !process.env.AZURE_PRINCIPAL_OBJECT_ID || !managedGetBlobToken)
                throw new Error('managed session cleanup is not configured');
            const { deleteSessionBlob } = await import('./azure-session-seed.mjs');
            const result = await deleteSessionBlob({ blobEndpoint: process.env.AZURE_BLOB_ENDPOINT, runId: checkedString(body.runId, 'runId'),
                kind: checkedString(body.kind, 'kind'), markerFingerprint: checkedFingerprint(body.markerFingerprint),
                etag: checkedEtag(body.etag), requestId: checkedRequestId(body.requestId),
                expectedPrincipalId: process.env.AZURE_PRINCIPAL_OBJECT_ID, expectedResourceId: process.env.THESIS_BLOB_RESOURCE_ID,
                expectedClientId: process.env.AZURE_CLIENT_ID,
                getManagedToken: managedGetBlobToken });
            return send(res, 200, result);
        }
        const scenario = checkedString(body.scenario, 'scenario');
        const runId = checkedString(body.runId, 'runId');
        if (!SCENARIOS.includes(scenario))
            return send(res, 400, { error: 'unknown scenario' });
        if (['U6', 'U8'].includes(scenario) && process.env.AZURE_PRINCIPAL_OBJECT_ID) {
            rejectCredentialFields(body);
            if (authMode === 'managed' && (!process.env.THESIS_BLOB_RESOURCE_ID || !process.env.AZURE_BLOB_ENDPOINT))
                throw new Error('request-ID-aware session read is not configured');
            body.requestId = checkedRequestId(body.requestId);
        }
        const u5Marker = typeof body.u5Marker === 'string' ? body.u5Marker : undefined;
        const workloadToken = authMode === 'delegated' ? body.mockWorkloadToken : token;
        if (typeof workloadToken !== 'string' || !workloadToken || /[\r\n]/.test(workloadToken) ||
            (authMode === 'delegated' && (workloadToken.length < 32 || workloadToken.length > 512)))
            throw new Error('missing or invalid workload credential');
        if (blobRunner && blobScenarios.has(scenario))
            return send(res, 200, await blobRunner({ runId, scenario,
                ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}) }));
        if (delegatedFactory && blobScenarios.has(scenario))
            return send(res, 200, await delegatedFactory(body)({ runId, scenario,
                ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}) }));
        return send(res, 200, await runScenario({ runId, scenario: scenario, u5Marker }, { workloadToken, resourceUrl, collectorUrl }));
    }
    catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
}).listen(port, '0.0.0.0', () => console.log(`agent listening on ${port}`));
