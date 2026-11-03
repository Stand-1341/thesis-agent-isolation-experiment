UNDERGRADUATE THESIS + AZURE BUILD INSTRUCTIONS + DOCKER STARTER
Prepared: 2026-10-28 | Updated package: 2026-11-03 (pre-deployment readiness audit)

START HERE
1. 01-FULL-THESIS-ORIGINAL.docx is the complete original undergraduate thesis.
   The manuscript is unchanged and has NOT been updated to Azure.
2. 02-AZURE-BUILD-GUIDE.docx (or .md) is the Azure-only implementation manual.
3. 05-DOCKER-STARTER/README.md explains the optional runnable Docker starter
   project. This is STARTER CODE, not a completed or production-ready system.
4. 05-DOCKER-STARTER/TESTING.md documents what was and was not verified.
5. 04-AZURE-THESIS-REVISION-CHECKLIST.md lists required thesis edits.
6. 03-PLANNED-TRIAL-MATRIX-450.csv is a plan, NOT collected results.
7. Also in this directory: 06-PROPOSED-AZURE-METHOD.md,
   08-AZURE-IDENTITY-DESIGN-DRAFT.md, 09-SESSION-POOL-PILOT.md,
   10-GPT5-MINI-LIVE-AGENT-PHASE-DRAFT.md, 11-AZURE-COST-AND-CREDIT-PLAN.md.
   07-PILOT-ACCEPTANCE.md is SUPERSEDED and is kept only as history: the release
   gate is 05-DOCKER-STARTER/PILOT-ACCEPTANCE.md, which is what every other
   document points at. Do not run trials against the 07 checklist.
8. READINESS-AUDIT.md (repository root) records what was verified against current
   Azure documentation before deployment, and what is still blocked.

DOCKER STARTER QUICK START (OPTIONAL)
  cd 05-DOCKER-STARTER
  docker compose up --build -d
  curl http://127.0.0.1:8081/health
  npm run smoke                  # requires local Node.js 22
  npm run plan                   # generates planned trial matrix only
  docker compose down

  npm run plan is a legacy planning sketch, not the study schedule. Its 6-column
  output is rejected by the only schedule loader ("matrix header does not match").
  The authoritative schedule is 03-PLANNED-TRIAL-MATRIX-450.csv. The command
  prints a warning saying so; do not treat its output as the plan of record.

If you do not want local Docker, use Azure Container Registry remote builds:
  az acr build --registry YOUR_ACR --image thesis-agent:starter-v1 \
    --file Dockerfile.node .
Run this from the 05-DOCKER-STARTER directory after Azure login and ACR creation.
The Azure Functions image has a separate Dockerfile.functions.

THE WORD 'STARTER' IS IMPORTANT
- Includes TypeScript source, precompiled dist, two Dockerfiles, Compose, a
  Functions adapter, and local mock services. NO prebuilt Docker image is included.
- Local tests of 30 scenarios are NOT Azure cloud trial results.
- No live Luna or Gemini connector is included; the deterministic baseline is the
  focus, as specified by the thesis.
- The P3 selective outbound network restriction has NOT been validated in Azure;
  this is a blocker for claiming a completed three-profile comparison.
- Azure credentials, student subscription quotas, registry/identity wiring,
  private networking and real independent audit logging require configuration.
- Demo credentials are for local use only. NEVER deploy them as actual secrets.
- Azure custom container sessions require OCI images and may incur dedicated
  compute costs even when sessions are idle.

ACADEMIC CAUTIONS
- The current manuscript still names Hetzner and Cloudflare, and needs explicit
  Azure methodology updates before results are presented.
- Chapter 3 calls for 450 deterministic trials, not 490. The 40 additional runs
  have no documented purpose and are not included as fabricated observations.
- Chapters 4 and 5 still contain template placeholders; don't claim trials
  happened until collected data supports them.
- Live cloud resources HAVE been created from this package. EXPERIMENT-STATUS.md
  records a research VM and a Flex Consumption Functions app both Running, the
  custom session pool thesis-diag-pool Succeeded with one ready session (maximum
  concurrency two), a Premium registry holding a pushed probe image, private
  endpoints, an Azure Firewall, a Log Analytics workspace and a Network Watcher
  VNet flow log. Cost Management reported USD 16.6029 month-to-date at the last
  check; the subscription budget's alerts are not a hard cap. Some earlier resources were deleted and rebuilt; the latest log
  entry still records infrastructure incurring charges. No measured trial has run.
  Cleanup is not one action: the VNet flow log in NetworkWatcherRG, the
  subscription-scoped synthetic-record custom role, the managed identities, the
  registry's private endpoints and the resource groups are separate items, and the
  03 log entry of 2026-11-03 says to remove the flow log separately. Verify what
  still exists with your own Azure credentials before assuming anything is gone.
