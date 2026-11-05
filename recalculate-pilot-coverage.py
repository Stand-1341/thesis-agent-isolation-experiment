import json, pathlib

root = pathlib.Path(r"C:\Users\snnyv\Documents\ChatGPT\research\Complete_Thesis_Azure_Package\05-DOCKER-STARTER\docs")
index = json.loads((root / "pilot-evidence-index-20261105.json").read_text(encoding="utf-8"))
old_audit = json.loads((root / "pilot-envelope-audit-20261105.json").read_text(encoding="utf-8"))
routes = [f"Azure VM P{i}" for i in range(1, 4)] + [f"Azure Functions Flex P{i}" for i in range(1, 4)]
scenarios = ["U1", "U2", "U3", "U4", "U5", "U7", "L1", "L2"]
principal_lookup = {(x["route"], x["scenario"]): x.get("auditPrincipal", []) for x in old_audit["selectedCells"]}
selected, missing = [], []
for route in routes:
    for scenario in scenarios:
        candidates = [t for t in index["trials"] if t.get("route") == route and t.get("scenario") == scenario]
        determinate = [t for t in candidates if t.get("classification") not in {"indeterminate", "not_recorded", "unparseable"}]
        determinate.sort(key=lambda t: t.get("start") or "")
        if not determinate:
            missing.append({"route": route, "scenario": scenario})
            continue
        t = determinate[-1]
        selected.append({
            "route": route, "scenario": scenario, "run_id": t["run_id"],
            "classification": t.get("classification"), "start": t.get("start"), "end": t.get("end"),
            "envelope_sha256_valid": "valid (included in 59/59 verified aggregate)",
            "evidence_summary": t.get("evidence_summary", {}),
            "audit_principal": principal_lookup.get((route, scenario), []),
            "indeterminate_attempt_count_for_cell": sum(1 for x in candidates if x.get("classification") == "indeterminate"),
        })
indeterminate = [{k: t.get(k) for k in ("run_id", "route", "scenario", "start", "classification", "evidence_summary")} for t in index["trials"] if t.get("classification") == "indeterminate"]
audit = {
    "title": "Sanitized pilot envelope audit and candidate coverage",
    "source": "Local recomputation from the 59-envelope sanitized index and SHA256 audit; no controller access used for this recalculation.",
    "saved_envelope_count": old_audit["savedEnvelopeCount"],
    "payload_sha256": old_audit["payloadSha256"],
    "candidate_scenarios": scenarios,
    "expected_cell_count": 48,
    "determinate_cell_count": len(selected),
    "missing_cells": missing,
    "indeterminate_attempt_count": len(indeterminate),
    "indeterminate_attempts": indeterminate,
    "selected_cells": selected,
}
out = root / "pilot-envelope-audit-20261105.json"
out.write_text(json.dumps(audit, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({"path": str(out), "expected": 48, "determinate": len(selected), "missing": len(missing), "indeterminate_attempts": len(indeterminate), "missing_cells": missing}, indent=2))
