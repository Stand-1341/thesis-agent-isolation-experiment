import {execFileSync} from 'node:child_process';

const RESOURCE_GROUP='RG-THESIS-RESEARCH-PILOT-EUS';
const FUNCTION_APP='thesis-flex-pilot-20261103';
const FUNCTION_NAME='thesisNetworkProbe';
const ENDPOINT='https://thesis-flex-pilot-20261103.azurewebsites.net/api/network-probe';

function runAzure(args) {
  try {
    const output=process.platform==='win32'
      ?execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`az ${args.join(' ')}`],
        {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']})
      :execFileSync('az',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']});
    return output.trim();
  } catch {
    throw new Error('Azure CLI could not retrieve probe credentials; no values were displayed.');
  }
}

function summarize(part) {
  const summarizeTransport=value=>value?.transport==='response'
    ?{transport:'response',status:value.status}
    :{transport:value?.transport||'missing',...(value?.errorType?{errorType:value.errorType}:{}),
      ...(value?.errorCode?{errorCode:value.errorCode}:{})};
  return {http:summarizeTransport(part?.http),directSocket:summarizeTransport(part?.directSocket)};
}

try {
  const functionKey=runAzure(['functionapp','function','keys','list','--resource-group',RESOURCE_GROUP,
    '--name',FUNCTION_APP,'--function-name',FUNCTION_NAME,'--query','default','--output','tsv']);
  const settings=JSON.parse(runAzure(['functionapp','config','appsettings','list','--resource-group',RESOURCE_GROUP,
    '--name',FUNCTION_APP,'--output','json']));
  const controllerKey=settings.find(item=>item?.name==='TRIAL_REQUEST_KEY')?.value;
  if(!functionKey || typeof controllerKey!=='string' || controllerKey.length<32)
    throw new Error('Required probe credential is missing; no values were displayed.');
  const response=await fetch(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{'content-type':'application/json','x-functions-key':functionKey,'x-trial-key':controllerKey},body:'{}'});
  let body;
  try { body=await response.json(); } catch { body={}; }
  if(!response.ok) throw new Error(`Function network probe returned HTTP ${response.status}; no values were displayed.`);
  process.stdout.write(JSON.stringify({scope:'connectivity_diagnostic_not_trial',status:response.status,
    research:summarize(body.approved),collector:summarize(body.restricted),
    tlsTrust:{configured:body.nodeTlsTrust?.configured===true,certificateReadable:body.nodeTlsTrust?.certificateReadable===true,
      isCertificateAuthority:body.nodeTlsTrust?.isCertificateAuthority===true}})+'\n');
} catch(error) {
  process.stderr.write(`${error?.message||'Function network probe failed'}\n`);
  process.exitCode=2;
}
