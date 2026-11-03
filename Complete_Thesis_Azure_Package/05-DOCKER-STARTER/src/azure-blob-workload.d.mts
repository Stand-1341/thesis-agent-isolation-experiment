export function createBlobWorkload(options: {blobEndpoint:string; getToken:()=>Promise<string>; dummyApiUrl?:string; dummyApiWorkloadToken?:string; timeoutMs?:number}):
  (input:{runId:string; scenario:string}) => Promise<unknown>;
