import base64, gzip, json, pathlib, re, subprocess

package = pathlib.Path(r"C:\Users\snnyv\Documents\ChatGPT\research\Complete_Thesis_Azure_Package\05-DOCKER-STARTER")
remote_script = pathlib.Path(r"C:\Users\snnyv\Documents\ChatGPT\research\audit-saved-envelopes.sh")
az = r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
cmd = f'"{az}" vm run-command invoke -g RG-THESIS-RESEARCH-PILOT-EUS -n thesis-controller-pilot --command-id RunShellScript --scripts @{remote_script} --query "value[].message" -o tsv'
res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=180)
if res.returncode:
    raise SystemExit(f"Azure Run Command failed with exit {res.returncode}; stderr omitted")
m = re.search(r"\[stdout\]\s*([A-Za-z0-9+/=]+)\s*\[stderr\]", res.stdout)
if not m:
    raise SystemExit("Could not locate compressed audit summary")
audit = json.loads(gzip.decompress(base64.b64decode(m.group(1))))
out = package / "docs" / "pilot-envelope-audit-20261105.json"
out.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"path": str(out), "savedEnvelopeCount": audit["savedEnvelopeCount"], "payloadSha256": audit["payloadSha256"], "determinateCellCount": audit["determinateCellCount"], "missingCellCount": len(audit["missingCells"]), "indeterminateAttempts": audit["indeterminateAttempts"], "invalidHashFiles": len(audit["invalidHashFiles"])}, indent=2))
