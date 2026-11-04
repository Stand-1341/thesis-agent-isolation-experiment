export function seedSessionBlob(options:{blobEndpoint:string;runId:string;kind:string;marker:string;azureAccessToken?:string;getManagedToken?:()=>Promise<string>;
  expectedPrincipalId:string;expectedClientId?:string;expectedResourceId?:string;requestId?:string;timeoutMs?:number;fetchImpl?:typeof fetch;now?:()=>number}):Promise<unknown>;
export function deleteSessionBlob(options:{blobEndpoint:string;runId:string;kind:string;markerFingerprint:string;etag:string;requestId:string;
  expectedPrincipalId:string;expectedClientId?:string;expectedResourceId:string;getManagedToken:()=>Promise<string>;timeoutMs?:number;fetchImpl?:typeof fetch;now?:()=>number}):Promise<unknown>;
