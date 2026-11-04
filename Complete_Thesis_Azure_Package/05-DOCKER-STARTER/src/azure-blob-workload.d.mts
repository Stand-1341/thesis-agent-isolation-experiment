export function createBlobWorkload(options: {blobEndpoint:string; getToken:()=>Promise<string>; blobResourceId?:string; expectedPrincipalId?:string; expectedClientId?:string;
  dummyApiUrl?:string; dummyApiWorkloadToken?:string; timeoutMs?:number}):
  (input:{runId:string; scenario:string; requestId?:string}) => Promise<unknown>;
