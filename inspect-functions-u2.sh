set +e
python3 - <<'PY'
import hashlib, json, re, urllib.error, urllib.parse, urllib.request
client='85b40cb2-af3c-4fe5-b2e0-464abafeb9ea'
params=urllib.parse.urlencode({'api-version':'2018-02-01','resource':'https://storage.azure.com/','client_id':client})
def get(url,headers):
 req=urllib.request.Request(url,headers=headers,method='GET')
 with urllib.request.urlopen(req,timeout=25) as r:return r.read()
try:
 t=json.loads(get('http://169.254.169.254/metadata/identity/oauth2/token?'+params,{'Metadata':'true'})).get('access_token')
 if not t: print(json.dumps({'error':'managed_identity_token_missing'}));raise SystemExit
 name='r4-vmfns-exec-draft-b01-azure_functions_flex-P1-U2-x01.json'
 url='https://thesispilotblob20261102.blob.core.windows.net/trial-evidence/'+name
 env=json.loads(get(url,{'Authorization':'Bearer '+t,'x-ms-version':'2023-11-03'}))
 payload=env.get('payload');record=json.loads(payload) if isinstance(payload,str) else payload
 digest=env.get('sha256'); hashok=isinstance(payload,str) and hashlib.sha256(payload.encode()).hexdigest()==str(digest).lower()
 wanted=('classification','reason','status','httpstatus','statuscode','error','verdict','principal','identity','endpoint','url','host','path','route','executionstartedat','executionfinishedat','startedat','finishedat','timestamp','operation','action','authorization')
 safe=[]
 def walk(v,p=''):
  if isinstance(v,dict):
   for k,x in v.items():
    nk=re.sub('[^a-z0-9]','',str(k).lower()); q=p+'.'+str(k) if p else str(k)
    if any(w in nk for w in wanted) and isinstance(x,(str,int,float,bool)):
     val=x
     if isinstance(val,str) and ('url' in nk or 'endpoint' in nk):
      try:
       u=urllib.parse.urlsplit(val); val=(u.scheme+'://' if u.scheme else '')+(u.hostname or '')+u.path
      except Exception:val='[redacted endpoint]'
     if isinstance(val,str):
      val=re.sub(r'(?i)(bearer\s+)[^\s,;]+',r'\1[redacted]',val)
      if len(val)>180:val=val[:180]+'…'
     safe.append({'field':q,'value':val})
    walk(x,q)
  elif isinstance(v,list):
   for i,x in enumerate(v[:30]):walk(x,f'{p}[{i}]')
 walk(record)
 print(json.dumps({'blob':name,'sha256Valid':hashok,'fields':safe},separators=(',',':')))
except urllib.error.HTTPError as e: print(json.dumps({'error':'http_error','status':e.code}))
except Exception as e: print(json.dumps({'error':type(e).__name__}))
PY
