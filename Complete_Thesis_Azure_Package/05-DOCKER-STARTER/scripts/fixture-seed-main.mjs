/** Run only as a separately controlled fixture-owner identity, never in a workload process. */
import {createFixtureSeedServer} from './fixture-seed-service.mjs';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';
const port=Number(process.env.PORT || 8080);
if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('invalid port');
const server=createFixtureSeedServer({requestKey:process.env.FIXTURE_REQUEST_KEY,blobEndpoint:process.env.AZURE_BLOB_ENDPOINT,
  ownerPrincipalId:process.env.FIXTURE_OWNER_PRINCIPAL_ID,sessionId:process.env.FIXTURE_SESSION_ID,
  getManagedToken:createManagedStorageTokenProvider({clientId:process.env.AZURE_CLIENT_ID || undefined})});
server.listen(port,'0.0.0.0',()=>console.log(`fixture seed service listening on ${port}`));
