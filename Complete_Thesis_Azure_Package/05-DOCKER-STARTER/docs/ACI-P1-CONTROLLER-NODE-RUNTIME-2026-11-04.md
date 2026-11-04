# ACI P1 controller Node.js runtime setup

- Checked: 2026-11-04 18:30 UTC.
- VM: `thesis-controller-pilot` in `RG-THESIS-RESEARCH-PILOT-EUS` (kept running).
- Installed Node.js `v22.23.4` and npm `10.9.9` under `/opt/node-v22.23.4-linux-x64`, with `/opt/node-current` and `/usr/local/bin` links.
- Downloaded the official Node.js Linux x64 archive and verified SHA-256 `1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce` against the Node.js `v22.23.4/SHASUMS256.txt` manifest before extraction.
- Removed the downloaded archive from `/tmp` after installation. Final remote check returned both version strings and executable checks passed.
- No runner files or secrets were transferred; no trial rows, ACI groups, or model calls were started.

This removes the controller's missing-runtime blocker only. The runner package still needs a secure transfer and dependency install, and pilot readiness gates for U1/U5 live verification, evidence protection and approved retention, complete credential validation, and cost controls remain open.
