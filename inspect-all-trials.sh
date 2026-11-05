set +e
python3 - "${1:-0}" "${2:-5}" <<'PY'
import json, pathlib, re, sys, gzip, base64
base=pathlib.Path('/opt/thesis-aci-runner-20261104/results')
allowed={'runid','trialid','route','scenario','classification','startedat','starttime','start','endedat','endtime','end','status','result','verdict','source','deniedrecords','rulename','reason','matchingrule','contacts','envelopesha256','envelopesha','sha256','envelopehash','count','attempt'}
def parse_nested(v):
 if isinstance(v,str) and v.lstrip().startswith(('{','[')):
  try: return json.loads(v)
  except Exception: return v
 return v
rows=[]
for path in sorted(base.rglob('*.json')):
 try: obj=json.loads(path.read_text())
 except Exception as e:
  rows.append({'file':str(path.relative_to(base)),'classification':'unparseable','parse_error':type(e).__name__}); continue
 row={'file':str(path.relative_to(base))}
 def walk(v, parent=''):
  v=parse_nested(v)
  if isinstance(v,dict):
   for k,x in v.items():
    key=str(k); norm=re.sub('[^a-z0-9]','',key.lower()); x=parse_nested(x)
    if norm in allowed and (isinstance(x,(str,int,float,bool)) or x is None):
     val=str(x)[:180] if x is not None else None
     row.setdefault(norm,val)
    if norm=='verificationevidence' and isinstance(x,(dict,list)):
     ev=[]
     def evwalk(a):
      if isinstance(a,dict):
       out={}
       for ek,ex in a.items():
        en=re.sub('[^a-z0-9]','',str(ek).lower())
        if en in {'verdict','source','deniedrecords','rulename','action','contacts','reason','matchingrule'} and (isinstance(ex,(str,int,float,bool)) or ex is None): out[en]=ex
        elif isinstance(ex,(dict,list)): child=evwalk(ex); out.update(child)
       return out
      if isinstance(a,list):
       out={}
       for it in a: out.update(evwalk(it))
       return out
      return {}
     ev=evwalk(x)
     if ev: row['verification']=ev
    walk(x,key)
  elif isinstance(v,list):
   for x in v: walk(x,parent)
 walk(obj)
 rows.append(row)
compact=[]
for r in rows:
 ev=r.get('verification',{}) if isinstance(r.get('verification',{}),dict) else {}
 evidence={}
 for k in ('reason','verdict','source','deniedrecords','rulename','matchingrule','contacts'):
  v=ev.get(k,r.get(k))
  if v is not None: evidence[k]=v
 if r.get('status') is not None: evidence['status']=r['status']
 compact.append([r.get('runid') or r.get('file'),r.get('scenario'),r.get('classification'),r.get('startedat') or r.get('starttime') or r.get('start'),r.get('endedat') or r.get('endtime') or r.get('end'),evidence])
payload=json.dumps(compact,separators=(',',':'),ensure_ascii=True).encode()
print(base64.b64encode(gzip.compress(payload,compresslevel=9)).decode())
PY
