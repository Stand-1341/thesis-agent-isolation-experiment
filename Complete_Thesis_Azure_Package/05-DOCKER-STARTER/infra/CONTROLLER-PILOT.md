# Dedicated controller pilot host

`controller-vm-pilot.bicep` deploys a temporary, private controller VM for
non-counted pilot execution. It creates a separate `experiment-controller`
subnet (default `10.48.11.0/24`), sends all routes through the existing Azure
Firewall, denies inbound connections, allows only HTTPS through the NSG, and
adds exact controller-to-research/collector firewall rules. It also adds
symmetric return routes through the firewall and scoped research/collector NSG
rules. It does not attach or alter `sessions-pilot`.

The template attaches the controller, Log Analytics reader, session-reader,
and ACR pull user-assigned identities so the runner can obtain scoped tokens
and pull a prebuilt image from the private ACR. It grants the controller
identity Blob Data Contributor only on the existing
`session-mappings` container; its fixture roles remain separately scoped. The
session-reader identity stays read-only. This template does not grant broad
storage access, create Function routes, or make evidence immutable. While the audit identity is
reachable from the controller host, this setup is only for a non-counted
pilot; it is not proof of independent evidence custody or measured-study
readiness.

The ACR pull identity is attached. The existing AcrPull assignment is
preprovisioned by the diagnostic foundation and this template leaves it
unchanged. The private controller VM has been deployed at `10.48.11.4` with
no public IP. Initial image `thesis-controller-pilot:1adac43` and updated image
`thesis-controller-pilot:functions-p1-kv-launcher-20261103` have been pushed
to the existing private ACR. The updated image was pulled onto the VM with
digest `sha256:2ab59fa1f8f994bea199b51f6cff1ca8da7d5230b994c8501de842a2ac7c6b9f`.
Docker 29.1.3 and Azure CLI 2.92.0 are installed on the VM. Managed-identity
login, image pull, CLI help, and a structural dry-run succeeded, but no cloud
scenario has been executed.

The firewall application rule accepts only the FQDNs passed in
`allowedApplicationFqdns`. ACR and Blob private endpoints use their exact
service FQDNs in application rules, which SNAT connections and preserve
symmetric return traffic. Do not allow private-endpoint IPs through network
rules: those rules preserve the controller source IP and can time out when the
return route is asymmetric. Include `login.microsoftonline.com` (and
`login.microsoft.com` if Azure CLI is used), `management.azure.com`,
`api.loganalytics.azure.com`, and the exact Functions hostnames for selected
pilot routes. The sample parameter file explicitly includes the current
`thesis-flex-pilot-20261103.azurewebsites.net` app, which does expose
`POST /api/run`. Its P1 managed identity is now attached, but this single app
has not passed a verifier-backed scenario. The controller firewall's public IP
must be allowed in the app's access restrictions. Add only package/session
endpoints the selected pilot needs. Do not pass wildcard FQDNs. Confirm ACR
and Blob service names against their current private DNS records and storage
account names; confirm the two research service IPs against the current NIC
state.

## Review and deploy

First compile and review the template and exact parameter file. The checked-in
`controller-vm-pilot.parameters.example.json` contains placeholders and must
not be deployed unchanged. Confirm private DNS mappings for ACR and Blob,
resolve an exact Ubuntu image version, and use a locally stored parameter file
with actual Function/session FQDNs and an SSH public key; do not put private
keys or workload secrets in it.

```powershell
az bicep build --file infra/controller-vm-pilot.bicep
az deployment group what-if `
  --resource-group rg-thesis-research-pilot-eus `
  --template-file infra/controller-vm-pilot.bicep `
  --parameters @infra/controller-vm-pilot.parameters.json
```

The deployment updates the shared firewall policy and two existing return
route tables, plus inbound rules on the research host NSG. Inspect every
change in `what-if` before deploying; confirm the session-pool subnet, NSG,
route table, and egress rules are unchanged. Once reviewed:

```powershell
az deployment group create `
  --name thesis-controller-pilot `
  --resource-group rg-thesis-research-pilot-eus `
  --template-file infra/controller-vm-pilot.bicep `
  --parameters @infra/controller-vm-pilot.parameters.json
```

After creation, bootstrap and validate the host through Azure Run Command;
verify no public IP exists, verify the public egress address is the firewall
address, and probe only the approved research, collector, Blob, Functions,
Entra, and Log Analytics endpoints. Then test denied destinations and require
the corresponding independent firewall record. Until all checks pass, use
only the frozen non-counted pilot schedule and do not assert measured gates.

This template has been compiled and deployed. A first bootstrap attempt used
an Ubuntu mirror hostname that failed TLS. The firewall rule now allows the
exact `archive.ubuntu.com` hostname, the Firewall and policy returned to
`Succeeded`, and a VM-side fetch from the corrected mirror succeeded. Live
tests found an NSG omission for controller-to-collector port 8443; a scoped
outbound rule was added and a controller-side TCP check passed. Network rules
to the private-endpoint IPs caused repeated TCP timeouts, so they were replaced
by exact ACR/Blob application FQDN rules to use firewall SNAT for symmetric
replies. The corrected ACR endpoint returned HTTP 401 as expected, and the
controller then completed managed-identity sign-in, ACR login, image pull, CLI
help, and a structural dry-run. The Key Vault is present but empty. Before
running the image launcher, an operator must provision six secrets in
`thesisexpkv20261103` using the matching values from the existing private Azure
configuration: `functions-p1-controller-key` (Functions app setting
`TRIAL_REQUEST_KEY`), `functions-p1-function-key` (the deployed `thesisRun`
function key), `resource-admin-key` (research host `ADMIN_TOKEN`),
`collector-admin-key` (collector host `ADMIN_TOKEN`),
`functions-p1-resource-verifier-key` (research host `VERIFIER_TOKEN`), and
`functions-p1-collector-verifier-key` (collector host `VERIFIER_TOKEN`). Do
use the hidden terminal prompts in `infra/provision-functions-p1-secrets.mjs`
from this package directory. Run `node ./infra/provision-functions-p1-secrets.mjs`
from the signed-in PowerShell session. This uses Node and Azure CLI, so it does
not require changing PowerShell's script execution policy. The helper submits
values directly to Key Vault and only prints the secret names. Do not put the
values in Git, command history, task logs, or chat. The controller identity
already has Key Vault Secrets User and the launcher fetches values in memory
through managed identity; it prints no secret contents. A missing or
inaccessible secret stops the launcher before any trial is claimed. After the
helper reports success, tell the experiment operator without sending values;
the temporary user role and client-address allowlist should then be removed.

With the secrets provisioned, run the container with no arguments to select
only the ten frozen Azure Functions P1 pilot rows, one at a time, in non-counted
pilot mode. `--limit 1` is available for the first single-row smoke. Do not
override the launcher config, route, profile, or mode. The pilot remains
incomplete for unsupported P3, and a successful P1 pilot does not establish
full-study readiness. Effective study-route isolation, attributable P3 denial
evidence, and measured readiness remain unvalidated.
