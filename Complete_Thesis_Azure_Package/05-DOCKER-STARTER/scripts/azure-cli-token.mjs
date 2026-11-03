/** Controller-only token provider. Never print the resulting bearer token. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
const audiences={storage:'https://storage.azure.com/',logs:'https://api.loganalytics.io',sessions:'https://dynamicsessions.io',openai:'https://cognitiveservices.azure.com'};

function createAzureCliTokenProvider(audience,{azureConfigDirectory,run=execFileAsync,platform=process.platform}={}) {
  const resource=audiences[audience];
  if (azureConfigDirectory!==undefined && (typeof azureConfigDirectory!=='string' || !azureConfigDirectory || /[\r\n\0]/.test(azureConfigDirectory))) throw new Error('invalid Azure CLI configuration path');
  const env={...process.env,...(azureConfigDirectory?{AZURE_CONFIG_DIR:azureConfigDirectory}:{})};
  return async function getStorageToken() {
    let result;
    try {
      if (platform==='win32') {
        // Fixed command text: no credentials, arguments, or user data are interpolated.
        const commands={
          storage:"$ErrorActionPreference = 'Stop'; az account get-access-token --resource https://storage.azure.com/ --query accessToken -o tsv; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
          logs:"$ErrorActionPreference = 'Stop'; az account get-access-token --resource https://api.loganalytics.io --query accessToken -o tsv; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
          sessions:"$ErrorActionPreference = 'Stop'; az account get-access-token --resource https://dynamicsessions.io --query accessToken -o tsv; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
          openai:"$ErrorActionPreference = 'Stop'; az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
        };
        const command=commands[audience];
        result=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env,timeout:30000,maxBuffer:262144,windowsHide:true});
      } else {
        result=await run('az',['account','get-access-token','--resource',resource,'--query','accessToken','-o','tsv'],{env,timeout:30000,maxBuffer:262144});
      }
    } catch { throw new Error('Azure CLI token acquisition failed'); }
    const token=String(result.stdout || '').trim();
    if (!token || /\s/.test(token)) throw new Error('Azure CLI returned an invalid storage token');
    return token;
  };
}
export function createAzureCliStorageTokenProvider(options) { return createAzureCliTokenProvider('storage',options); }
export function createAzureCliLogsTokenProvider(options) { return createAzureCliTokenProvider('logs',options); }
export function createAzureCliSessionsTokenProvider(options) { return createAzureCliTokenProvider('sessions',options); }
export function createAzureCliOpenAITokenProvider(options) { return createAzureCliTokenProvider('openai',options); }
