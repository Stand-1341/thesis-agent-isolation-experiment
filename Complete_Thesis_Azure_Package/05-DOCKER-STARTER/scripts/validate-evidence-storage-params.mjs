import { readFile } from 'node:fs/promises';

const objectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check the security-sensitive shape of an ARM/Bicep parameter file before
 * deployment. This does not verify actual Azure RBAC assignments or network paths.
 */
export function validateEvidenceStorageParameters(parameters) {
  const unwrap = (key) => {
    const value = parameters?.[key];
    return value && typeof value === 'object' && 'value' in value ? value.value : value;
  };
  const identities = [
    ['writerPrincipalId', unwrap('writerPrincipalId')],
    ['readerPrincipalId', unwrap('readerPrincipalId')],
    ['sessionRegistryReaderPrincipalId', unwrap('sessionRegistryReaderPrincipalId')],
  ];
  for (const [name, value] of identities) {
    if (typeof value !== 'string' || !objectId.test(value)) {
      throw new Error(`${name} must be a valid Entra object ID`);
    }
  }
  if (new Set(identities.map(([, value]) => value.toLowerCase())).size !== identities.length) {
    throw new Error('writer, evidence verifier, and session registry reader principals must be distinct');
  }

  const retention = unwrap('evidenceRetentionDays');
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error('evidenceRetentionDays must be an integer of at least 1 day');
  }
  return {
    principalsDistinct: true,
    evidenceRetentionDays: retention,
    status: 'parameter_shape_only_effective_azure_permissions_unverified',
  };
}

async function main() {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/validate-evidence-storage-params.mjs <arm-parameters.json>');
  }
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const result = validateEvidenceStorageParameters(parsed.parameters ?? parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
