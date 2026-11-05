set +e
python3 - <<'PY'
import hashlib, json, re, urllib.error, urllib.parse, urllib.request, xml.etree.ElementTree as ET
client='85b40cb2-af3c-4fe5-b2e0-464abafeb9ea'
params=urllib.parse.urlencode({'api-version':'2018-02-01','resource':'https://storage.azure.com/','client_id':client})
def get(url,headers):
 req=urllib.request.Request(url,headers=headers,method='GET')
 with urllib.request.urlopen(req,timeout=30) as r:return r.read()
try:
 token=json.loads(get('http://169.254.169.254/metadata/identity/oauth2/token?'+params,{'Metadata':'true'})).get('access_token')
 if not token: print(json.dumps({'error':'managed_identity_token_missing'}));raise SystemExit
 headers={'Authorization':'Bearer '+token,'x-ms-version':'2023-11-03'}
 base='https://thesispilotblob20261102.blob.core.windows.net/trial-evidence'
 raw=get(base+'?'+urllib.parse.urlencode({'restype':'container','comp':'list'}),headers)
 root=ET.fromstring(raw); names=[x.text for x in root.findall('.//{*}Blob/{*}Name')]
 items=[]
 for name in sorted(names):
  if name.endswith('.claim'):
   items.append({'type':'claim','id':name[:-6],'name':name});continue
  if not name.endswith('.json'):
   items.append({'type':'other','name':name});continue
  try:
   env=json.loads(get(base+'/'+urllib.parse.quote(name,safe='/'),headers))
   payload=env.get('payload') if isinstance(env,dict) else None
   digest=env.get('sha256') if isinstance(env,dict) else None
   h='valid' if isinstance(payload,str) and isinstance(digest,str) and hashlib.sha256(payload.encode()).hexdigest()==digest.lower() else ('missing' if not digest else 'uncheckable')
   rec=json.loads(payload) if isinstance(payload,str) else payload
   if not isinstance(rec,dict):rec={}
   rid=rec.get('runId') or name[:-5]
   items.append({'type':'record','id':rid,'name':name,'mode':rec.get('mode'),'classification':rec.get('classification'),'executionStartedAt':rec.get('executionStartedAt'),'executionFinishedAt':rec.get('executionFinishedAt'),'hash':h})
  except Exception as e:items.append({'type':'record','id':name[:-5],'name':name,'parseError':type(e).__name__})
 claims={x['id'] for x in items if x['type']=='claim'}
 records={x['id'] for x in items if x['type']=='record'}
 counts={}
 for x in items:
  if x['type']=='record':
   key=x.get('classification') or 'unclassified'
   counts[key]=counts.get(key,0)+1
 print(json.dumps({'containerObjectCount':len(names),'claims':sum(x['type']=='claim' for x in items),'records':sum(x['type']=='record' for x in items),'classificationCounts':counts,'outstandingClaims':sorted(claims-records),'items':items},separators=(',',':')))
except urllib.error.HTTPError as e: print(json.dumps({'error':'http_error','status':e.code}))
except Exception as e: print(json.dumps({'error':type(e).__name__}))
PY
