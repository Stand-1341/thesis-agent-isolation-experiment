set +e
for s in thesis-vmfns-rev5-idfix-measured thesis-vmfns-rev5-idfix-measured.service; do
  if systemctl list-unit-files "$s" --no-legend --no-pager 2>/dev/null | grep -q "$s"; then
    echo "UNIT=$s"
    systemctl show "$s" --no-pager -p LoadState -p ActiveState -p SubState -p MainPID -p ExecMainStatus -p ActiveEnterTimestamp
  fi
done
if command -v docker >/dev/null 2>&1; then
  echo DOCKER_CONTAINERS
  docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i 'rev5\|measured' || true
fi
python3 - <<'PY'
from pathlib import Path
for p in Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try: b=(p/'cmdline').read_bytes().lower()
 except OSError: continue
 if b'rev5-idfix' in b or b'vmfns-rev5' in b:
  print('MATCHING_PROCESS_PID='+p.name)
PY
