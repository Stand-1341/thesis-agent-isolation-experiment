set +e
python3 - <<'PY'
import re, subprocess
name='thesis-vmfns-rev5-idfix-measured.service'
r=subprocess.run(['journalctl','-u',name,'-n','60','--no-pager','-o','cat'],capture_output=True,text=True)
lines=[]
for line in r.stdout.splitlines():
 if re.search(r'error|fail|refus|blocked|gate|assert|exception|exit|denied|not found',line,re.I):
  line=re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*',r'\1[REDACTED]',line)
  line=re.sub(r'(?i)(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+',r'\1=[REDACTED]',line)
  line=re.sub(r'(?i)(sig|se|sp|sv|sr|st|spr)=[^&\s]+',r'\1=[REDACTED]',line)
  lines.append(line[:300])
print('\n'.join(lines[-20:]) if lines else 'NO_FAILURE_LINES')
if r.returncode not in (0,1):print('JOURNAL_EXIT='+str(r.returncode))
PY
