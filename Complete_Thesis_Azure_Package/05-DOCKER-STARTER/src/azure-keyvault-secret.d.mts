export interface ManagedKeyVaultSecretReaderOptions {
  clientId?:string;
}

export function createManagedKeyVaultSecretReader(options?:ManagedKeyVaultSecretReaderOptions):
  (secretUri:string)=>Promise<string>;
