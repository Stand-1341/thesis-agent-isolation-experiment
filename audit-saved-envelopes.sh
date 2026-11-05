set +e
python3 - <<'PY'
import base64, gzip, hashlib, json, pathlib, re
base=pathlib.Path('/opt/thesis-aci-runner-20261104/results')
def nested(v):
 if isinstance(v,str) and v.lstrip().startswith(('{','[')):
  try:return json.loads(v)
  except Exception:return v
 return v
def find(obj,names):
 if isinstance(obj,dict):
  for k,v in obj.items():
   if re.sub('[^a-z0-9]','',str(k).lower()) in names and isinstance(v,(str,int,float,bool)): return str(v)
  for v in obj.values():
   z=find(v,names)
   if z is not None:return z
 if isinstance(obj,list):
  for v in obj:
   z=find(v,names)
   if z is not None:return z
 return None
def principals(v):
 out=[]
 names={'principal','principalid','principalname','auditprincipal','caller','calleridentity','identity','identityname','userprincipalname','serviceprincipalname'}
 if isinstance(v,dict):
  for k,x in v.items():
   nk=re.sub('[^a-z0-9]','',str(k).lower())
   if nk in names and isinstance(x,(str,int,float)) and not any(s in nk for s in ('token','secret','password','credential','key')): out.append(str(x)[:120])
   else: out.extend(principals(x))
 elif isinstance(v,list):
  for x in v:out.extend(principals(x))
 return list(dict.fromkeys(out))
records=[]; hc={'valid':0,'invalid':0,'missing':0,'uncheckable':0}; invalid=[]; indeterminate=0
for path in sorted(base.rglob('*.json')):
 try: env=json.loads(path.read_text())
 except Exception: hc['uncheckable']+=1; continue
 payload=env.get('payload') if isinstance(env,dict) else None
 digest=find(env,{'sha256','payloadsha256','envelopesha256','envelopesha','hash'})
 if digest is None: state='missing'
 elif isinstance(payload,str):
  state='valid' if hashlib.sha256(payload.encode('utf-8')).hexdigest().lower()==digest.lower() else 'invalid'
 else: state='uncheckable'
 hc[state]+=1
 if state=='invalid': invalid.append(path.name)
 obj=nested(payload)
 rid=find(obj,{'runid','trialid'}) or path.stem
 cls=find(obj,{'classification'})
 scenario=find(obj,{'scenario'})
 start=find(obj,{'startedat','starttime','start'})
 if cls=='indeterminate':indeterminate+=1
 ident=rid.lower()
 prov='Azure Functions Flex' if ('azure_functions_flex' in ident or 'functions' in ident) else ('Azure VM' if ('azure_vm' in ident or 'r4vm' in ident or 'central-vm' in ident) else None)
 m=re.search(r'-(p\d+)-(u\d+|l\d+)(?:-|$)',ident)
 if scenario is None and m:scenario=m.group(2).upper()
 if prov and m and scenario and str(scenario).upper() in {f'U{i}' for i in range(1,9)}:
  ver=None
  if isinstance(obj,dict):
   for k,v in obj.items():
    if re.sub('[^a-z0-9]','',str(k).lower())=='verificationevidence':ver=v;break
  records.append({'route':prov+' '+m.group(1).upper(),'scenario':str(scenario).upper(),'runId':rid,'classification':cls or 'not_recorded','start':start,'hash':state,'auditPrincipal':principals(ver) if ver is not None else []})
routes=[f'{p} P{n}' for p in ('Azure VM','Azure Functions Flex') for n in range(1,4)]
scenarios=[f'U{i}' for i in range(1,9)]
selected=[];missing=[]; determinate=lambda x:x['classification'] not in {'indeterminate','not_recorded','unparseable'}
for route in routes:
 for scenario in scenarios:
  cell=[r for r in records if r['route']==route and r['scenario']==scenario and determinate(r)]
  cell.sort(key=lambda r:r['start'] or '')
  if cell:selected.append(cell[-1])
  else:missing.append({'route':route,'scenario':scenario})
out={'savedEnvelopeCount':sum(hc.values()),'payloadSha256':hc,'invalidHashFiles':invalid,'indeterminateAttempts':indeterminate,'determinateCellCount':len(selected),'expectedCellCount':48,'missingCells':missing,'selectedCells':selected}
print(base64.b64encode(gzip.compress(json.dumps(out,separators=(',',':')).encode(),compresslevel=9)).decode())
PY
