/** Trusted, disposable diagnostic workload. Never print or return header values. */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { connect as connectTcp, isIPv4 } from 'node:net';
import { bodyJson, send } from './helpers.js';
const port = Number(process.env.PORT || 8080);
const directIpProbe = () => new Promise(resolve => {
    const host = process.env.P3_PUBLIC_IP_PROBE_HOST || '';
    const port = Number(process.env.P3_PUBLIC_IP_PROBE_PORT || 443);
    if (!isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535)
        return resolve(false);
    const socket = connectTcp({ host, port });
    let settled = false;
    const finish = (connected) => { if (settled)
        return; settled = true; socket.destroy(); resolve(connected); };
    socket.setTimeout(3000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
});
createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://localhost:${port}`);
    if (req.method === 'POST' && requestUrl.pathname === '/probe') {
        const targets = [
            ['research', process.env.P3_RESEARCH_PROBE_URL],
            ['collector', process.env.P3_COLLECTOR_PROBE_URL],
            ['blob', process.env.P3_BLOB_PROBE_URL]
        ];
        const results = [];
        for (const [name, target] of targets) {
            if (!target)
                return send(res, 503, { error: 'probe target not configured' });
            try {
                const url = new URL(target);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
                    throw new Error('invalid target');
                const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
                await response.body?.cancel();
                results.push({ name, connected: true, status: response.status });
            }
            catch {
                results.push({ name, connected: false, status: null });
            }
        }
        results.push({ name: 'publicIp', connected: await directIpProbe(), status: null });
        return send(res, 200, { scope: 'fixed_pilot_network_probe', results });
    }
    if (req.method !== 'POST' || requestUrl.pathname !== '/inspect')
        return send(res, 404, { error: 'not found' });
    try {
        const body = await bodyJson(req);
        const tokenHash = body.tokenSha256, sessionHash = body.sessionIdSha256;
        if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash) ||
            typeof sessionHash !== 'string' || !/^[a-f0-9]{64}$/.test(sessionHash))
            return send(res, 400, { error: 'invalid diagnostic request' });
        const values = [];
        for (const value of Object.values(req.headers)) {
            for (const text of Array.isArray(value) ? value : (value === undefined ? [] : [value])) {
                values.push(text);
                if (/^Bearer\s+/i.test(text))
                    values.push(text.replace(/^Bearer\s+/i, ''));
            }
        }
        for (const value of requestUrl.searchParams.values())
            values.push(value);
        const hashes = new Set(values.map(value => createHash('sha256').update(value).digest('hex')));
        return send(res, 200, { authorizationHeaderPresent: typeof req.headers.authorization === 'string',
            proxyAuthorizationHeaderPresent: typeof req.headers['proxy-authorization'] === 'string',
            credentialLikeHeaderNames: Object.keys(req.headers).filter(name => /auth|token|credential/i.test(name)).sort(),
            controlTokenValuePresent: hashes.has(tokenHash), sessionIdentifierValuePresent: hashes.has(sessionHash) });
    }
    catch {
        return send(res, 400, { error: 'invalid diagnostic request' });
    }
}).listen(port, '0.0.0.0', () => console.log(`header diagnostic listening on ${port}`));
