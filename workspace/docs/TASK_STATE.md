# ACTIVE_CONTRACT / TASK_STATE

Contract revision 2, 2026-09-30. User instruction: «Положи в tg-mcp рядом. Авторизация будет таже + приложение развернуто + бд есть».

Target: rtalyutin/Tg-mcp, sibling workspace module beside dashboard. Reuse deployed application's existing owner session, query-login MCP and PostgreSQL. Backend only; preserve existing Telegram/dashboard. Necessary additive schema and build integration are in scope. Sending messages, paid model calls, enabling schedules and replacing production data are out of scope.

Producer: primary agent using Developer/DevOps/Release-SRE. Independent verifier: workspace_host_verifier. Handoff schema FEATURE_HANDOFF/1.

Baseline: standalone backend 1.0.1 commit 67fad97c8a82d5af9e579fd7672539f44bcccf08. Historical native evidence in VERIFICATION.md concerns that baseline, not the new host adapter.

Artifact revision: host integration 1.0.2; final source commit and CI/deployment readback recorded in the PR and delivery report. Root build generates workspace/dist/build-info.json with a digest of runtime source, migrations and root dependency/config integration.

Changes: existing authentication adapter; namespaced root MCP and protected owner API; isolated roman_workspace search path/ledger; persistent Postgres blobs/signing key; schema-aware export/restore; raw database access excludes internal workspace/auth/system tables; optional module startup/shutdown.

Gate: local type checks/build and available root regression tests; independent trust-boundary review; native PostgreSQL host/legacy tests in CI. Local native harness blocked by root-only UID map (chown65534 EINVAL); do not count unexecuted native tests as PASS. Deployment is separate: compare live authenticated module digest with the tested build before confirming exposure.

Open dependencies: pane/desktop frontend, actual skill/connector imports, separately configured worker runtime. Existing worker remains disabled and no real recurring jobs are activated. These were not requested in this placement step.
