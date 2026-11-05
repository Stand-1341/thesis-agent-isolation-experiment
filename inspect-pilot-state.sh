set +e
pids=$(pgrep -f '[r]un-final-route-coverage-pilot-v4.mjs' | tr '\n' ',')
if [ -n "$pids" ]; then echo PROCESS_PIDS=$pids; else echo PROCESS_NOT_RUNNING; fi
d=/opt/thesis-aci-runner-20261104/results/non-counted-final-route-coverage-20261105-v4
if [ -d "$d" ]; then
  echo RESULTS_DIR_EXISTS
  find "$d" -maxdepth 2 -type f -printf 'FILE=%P (%s bytes)\n' | sort
  python3 - "$d" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
for unit in ('U5','U7'):
  matches=sorted(root.glob(f'*{unit}.json'))
  for path in matches:
    try: obj=json.loads(path.read_text())
    except Exception as e:
      print(f'{unit}: JSON_PARSE_ERROR={type(e).__name__}'); continue
    print(f'{unit}: FILE={path.name}')
    def walk(v, prefix=''):
      if isinstance(v,dict):
        for k,x in v.items():
          key=str(k); lk=key.lower(); p=f'{prefix}.{key}' if prefix else key
          if any(w in lk for w in ('classification','verify','reason','matching','rule','count','status','deniedrecords','contacts','verdict','source')):
            safe=x if isinstance(x,(str,int,float,bool)) or x is None else '[structured value]'
            print(f'  {p}={safe}')
          walk(x,p)
      elif isinstance(v,list):
        for i,x in enumerate(v): walk(x,f'{prefix}[{i}]')
      elif isinstance(v,str) and v.lstrip().startswith(('{','[')):
        try: walk(json.loads(v),prefix+'[parsed_payload]')
        except Exception: pass
    walk(obj)
PY
else
  echo RESULTS_DIR_NOT_FOUND
fi
