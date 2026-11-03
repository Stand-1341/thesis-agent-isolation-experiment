/** Scenario estimate only; does not invoke a model or predict actual token usage. */
import {pathToFileURL} from 'node:url';
// Azure GPT-5 mini Global Standard short-context rates (USD per million tokens).
// Infrastructure and long-context usage are excluded; the deterministic baseline makes no model calls.
export function estimate({calls, inputTokens, outputTokens, inputRate = 0.25, outputRate = 2}) {
  for (const [name, value] of Object.entries({calls, inputTokens, outputTokens, inputRate, outputRate})) {
    if (!Number.isFinite(value) || value < 0 || (['calls','inputTokens','outputTokens'].includes(name) && !Number.isInteger(value))) {
      throw new RangeError(`${name} must be a nonnegative ${name.endsWith('Rate') ? 'number' : 'integer'}`);
    }
  }
  return {calls, totalInputTokens: calls * inputTokens, totalOutputTokens: calls * outputTokens,
    estimatedUsd: calls * (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [calls, inputTokens, outputTokens] = process.argv.slice(2).map(Number);
  try { console.log(JSON.stringify(estimate({calls, inputTokens, outputTokens}), null, 2)); }
  catch (error) { console.error('Usage: node scripts/estimate-model-cost.mjs <calls> <input-tokens-per-call> <output-tokens-per-call>'); process.exitCode = 1; }
}
