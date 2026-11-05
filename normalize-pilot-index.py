import json, pathlib, re
p = pathlib.Path(r"C:\Users\snnyv\Documents\ChatGPT\research\Complete_Thesis_Azure_Package\05-DOCKER-STARTER\docs\pilot-evidence-index-20261105.json")
data = json.loads(p.read_text(encoding="utf-8"))
for t in data["trials"]:
    ident = (t.get("run_id") or "").lower()
    provider = "Azure Functions Flex" if ("azure_functions_flex" in ident or "functions" in ident) else ("Azure VM" if ("azure_vm" in ident or "r4vm" in ident or "central-vm" in ident) else "unknown")
    m = re.search(r"-(p\d+)-(u\d+|l\d+)(?:-|$)", ident)
    if m:
        t["route"] = f"{provider} {m.group(1).upper()}"
        t["scenario"] = t.get("scenario") or m.group(2).upper()
    elif t.get("route") in (None, "unknown"):
        t["route"] = provider
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"normalized {len(data['trials'])} trial route labels")
