import base64, gzip, json, pathlib, re, subprocess

package = pathlib.Path(r"C:\Users\snnyv\Documents\ChatGPT\research\Complete_Thesis_Azure_Package\05-DOCKER-STARTER")
remote_script = pathlib.Path(r"C:\Users\snnyv\Documents\ChatGPT\research\inspect-all-trials.sh")
az = r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
cmd = f'"{az}" vm run-command invoke -g RG-THESIS-RESEARCH-PILOT-EUS -n thesis-controller-pilot --command-id RunShellScript --scripts @{remote_script} --query "value[].message" -o tsv'
res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=180)
if res.returncode:
    raise SystemExit(f"Azure Run Command failed with exit {res.returncode}; stderr omitted to avoid exposing unrelated data")
m = re.search(r"\[stdout\]\s*([A-Za-z0-9+/=]+)\s*\[stderr\]", res.stdout)
if not m:
    raise SystemExit("Could not locate sanitized compressed payload in Run Command output")
compact = json.loads(gzip.decompress(base64.b64decode(m.group(1))))
rows = []
for item in compact:
    rid, scenario, classification, start, end, evidence = item
    rows.append({"runid": rid, "scenario": scenario, "classification": classification or "not_recorded", "startedat": start, "endedat": end, "verification": evidence})

def choose(row, *keys):
    for k in keys:
        v = row.get(k)
        if v not in (None, "", "None"):
            return v
    return None

trials = []
for r in rows:
    name = pathlib.PurePosixPath(r.get("file", "")).name
    identity = str(r.get("runid") or pathlib.PurePosixPath(name).stem)
    low_identity = identity.lower()
    provider = "Azure Functions Flex" if ("azure_functions_flex" in low_identity or "functions" in low_identity) else ("Azure VM" if ("azure_vm" in low_identity or "r4vm" in low_identity or "central-vm" in low_identity) else "unknown")
    mscenario = re.search(r"-(P\d+)-(U\d+|L\d+)(?:-|$)", identity, re.I)
    route = r.get("route") or (f"{provider} {mscenario.group(1)}" if mscenario else provider)
    ev = r.get("verification", {})
    summary = {}
    for key in ("reason", "verdict", "source", "deniedrecords", "rulename", "matchingrule", "contacts"):
        v = ev.get(key) if isinstance(ev, dict) else None
        if v is None:
            v = r.get(key)
        if v is not None:
            summary[key] = v
    if r.get("status") is not None:
        summary["status"] = r["status"]
    trials.append({
        "run_id": identity,
        "envelope_file": r.get("file"),
        "route": route,
        "scenario": r.get("scenario") or (mscenario.group(2).upper() if mscenario else None),
        "classification": r.get("classification", "indeterminate"),
        "start": choose(r, "startedat", "starttime", "start"),
        "end": choose(r, "endedat", "endtime", "end"),
        "envelope_sha256": None,
        "evidence_summary": summary,
    })

index = {
    "title": "Sanitized pilot evidence index",
    "source": "Read-only Azure Run Command inspection of saved controller JSON envelopes",
    "controller_vm": "thesis-controller-pilot",
    "results_root": "/opt/thesis-aci-runner-20261104/results",
    "record_count": len(trials),
    "notes": [
        "Indeterminate and retry attempts are retained as separate saved envelopes.",
        "Only allowlisted metadata and compact verification evidence were exported; secrets and raw evidence payloads were excluded.",
        "Envelope SHA fields were omitted from the compact Azure Run Command transfer to fit its output limit.",
        "Missing start/end/hash fields are null because they were not present in the inspected envelope metadata.",
    ],
    "trials": trials,
}
out = package / "docs" / "pilot-evidence-index-20261105.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"path": str(out), "record_count": len(trials), "classifications": {k: sum(1 for t in trials if t["classification"] == k) for k in sorted({t["classification"] for t in trials})}, "indeterminate": sum(1 for t in trials if t["classification"] == "indeterminate")}, indent=2))
