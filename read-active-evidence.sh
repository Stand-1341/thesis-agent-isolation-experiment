set +e
python3 - <<'PY'
import hashlib, json, urllib.error, urllib.parse, urllib.request, xml.etree.ElementTree as ET
client='85b40cb2-af3c-4fe5-b2e0-464abafeb9ea'
params=urllib.parse.urlencode({'api-version':'2018-02-01','resource':'https://storage.azure.com/','client_id':client})
def get(url,headers,timeout=25):
 req=urllib.request.Request(url,headers=headers,method='GET')
 with urllib.request.urlopen(req,timeout=timeout) as r:return r.read()
try:
 token_doc=json.loads(get('http://169.254.169.254/metadata/identity/oauth2/token?'+params,{'Metadata':'true'}))
 token=token_doc.get('access_token')
 if not token: print(json.dumps({'error':'managed_identity_token_missing'}));raise SystemExit
 headers={'Authorization':'Bearer '+token,'x-ms-version':'2023-11-03'}
 base='https://thesispilotblob20261102.blob.core.windows.net/trial-evidence'
 q=urllib.parse.urlencode({'restype':'container','comp':'list','prefix':'r4-vmfns-exec-draft-b01-'})
 raw=get(base+'?'+q,headers)
 root=ET.fromstring(raw)
 names=[x.text for x in root.findall('.//{*}Blob/{*}Name')]
 out=[]
 for name in names:
  data=get(base+'/'+urllib.parse.quote(name,safe='/'),headers)
  try: env=json.loads(data)
  except Exception: out.append({'blob':name,'parse':'unparseable'});continue
  payload=env.get('payload') if isinstance(env,dict) else None
  digest=env.get('sha256') if isinstance(env,dict) else None
  pbytes=payload.encode() if isinstance(payload,str) else None
  hash_state=('valid' if hashlib.sha256(pbytes).hexdigest()==str(digest).lower() else 'invalid') if pbytes and digest else ('missing' if not digest else 'uncheckable')
  try: record=json.loads(payload) if isinstance(payload,str) else payload
  except Exception:record={}
  if not isinstance(record,dict):record={}
  out.append({'blob':name,'type':'claim' if name.endswith('.claim') else 'record','runId':record.get('runId'),'trialId':record.get('trialId'),'scenario':record.get('scenario'),'mode':record.get('mode'),'classification':record.get('classification'),'executionStartedAt':record.get('executionStartedAt'),'executionFinishedAt':record.get('executionFinishedAt'),'hash':hash_state})
 print(json.dumps({'count':len(out),'objects':out},separators=(',',':')))
except urllib.error.HTTPError as e: print(json.dumps({'error':'http_error','status':e.code}))
except Exception as e: print(json.dumps({'error':type(e).__name__}))
PY
