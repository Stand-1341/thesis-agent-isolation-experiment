/** Reject local demo defaults in the explicitly selected Azure pilot mode. */
export function validateResearchServiceConfig(kind, env) {
    if (env.NODE_ENV === 'production' && !env.RESEARCH_SERVICE_MODE)
        throw new Error('production requires an explicit research service mode');
    const mode = env.RESEARCH_SERVICE_MODE || 'local';
    if (!['local', 'azure-pilot'].includes(mode))
        throw new Error('invalid research service mode');
    if (mode === 'local')
        return;
    const names = kind === 'resource' ? ['ADMIN_TOKEN', 'VERIFIER_TOKEN', 'P1_TOKEN', 'P2_TOKEN', 'P3_TOKEN'] : ['ADMIN_TOKEN', 'VERIFIER_TOKEN'];
    const values = names.map(name => env[name]);
    if (values.some(value => typeof value !== 'string' || value.length < 32 || value.length > 512 || /[\r\n]/.test(value)) || new Set(values).size !== values.length)
        throw new Error('Azure pilot requires explicit, distinct service credentials');
    const path = env[kind === 'resource' ? 'RESOURCE_JOURNAL_PATH' : 'COLLECTOR_JOURNAL_PATH'];
    const expected = kind === 'resource' ? '/srv/thesis-data/resource/events.jsonl' : '/srv/thesis-data/collector/events.jsonl';
    if (path !== expected)
        throw new Error('Azure pilot requires the configured data-disk journal path');
}
