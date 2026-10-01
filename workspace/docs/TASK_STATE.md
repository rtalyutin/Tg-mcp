# ACTIVE_CONTRACT / TASK_STATE

Historical contract revision 2, 2026-09-30. User instruction: «Положи в tg-mcp рядом. Авторизация будет таже + приложение развернуто + бд есть».

Target: rtalyutin/Tg-mcp, sibling workspace module beside dashboard. Reuse deployed application's existing owner session, query-login MCP and PostgreSQL. Backend only; preserve existing Telegram/dashboard. Necessary additive schema and build integration are in scope. Sending messages, paid model calls, enabling schedules and replacing production data are out of scope.

Producer: primary agent using Developer/DevOps/Release-SRE. Independent verifier: workspace_host_verifier. Handoff schema FEATURE_HANDOFF/1.

Baseline: standalone backend 1.0.1 commit 67fad97c8a82d5af9e579fd7672539f44bcccf08. Historical native evidence in VERIFICATION.md concerns that baseline, not the new host adapter.

Artifact revision: host integration 1.0.2; final source commit and CI/deployment readback recorded in the PR and delivery report. Root build generates workspace/dist/build-info.json with a digest of runtime source, migrations and root dependency/config integration.

Changes: existing authentication adapter; namespaced root MCP and protected owner API; isolated roman_workspace search path/ledger; persistent Postgres blobs/signing key; schema-aware export/restore; raw database access excludes internal workspace/auth/system tables; optional module startup/shutdown.

Gate: local type checks/build and available root regression tests; independent trust-boundary review; native PostgreSQL host/legacy tests in CI. Local native harness blocked by root-only UID map (chown65534 EINVAL); do not count unexecuted native tests as PASS. Deployment is separate: compare live authenticated module digest with the tested build before confirming exposure.

Open dependencies: pane/desktop frontend, actual skill/connector imports, separately configured worker runtime. Existing worker remains disabled and no real recurring jobs are activated. These were not requested in this placement step.


## ACTIVE_CONTRACT — revision 3, 2026-10-01

User instruction: «Делаем 1ый экран». Target: first working «Проекты» screen in the existing Tg-mcp app and an MCP Apps resource for the plugin. Preserve the selected reference: dark sidebar, light workspace, projects left, «Внимание» right; no account block below. The same screen/behavior applies to all projects. On narrow screens attention follows the projects.

Scope: real owner API/MCP data, initial tool-result hydration, search, active/archive, attention filtering/pagination including subprojects, create project with idempotent retry, read-only project/task/event/material detail, loading/empty/auth/error states. No automatic run, chat message, project import, worker activation or schedules. Other sidebar sections stay disabled. Producer: primary agent using Developer/Metamorph/DevOps. Independent verifier: projects_screen_verifier; FEATURE_HANDOFF/1.

Artifact: backend 1.0.3 + UI 1.0.0, branch feat/workspace-projects-screen. Single HTML UI, existing HTTP server and MCP resource, additive attention API fields. Root build digest binds UI source/build script/dependencies alongside backend. No new server, account, production secrets or DB migration.

Local gates: type checks, root build, workspace format, UI model tests, HTTP/MCP routing/resource metadata/CSP tests, PGlite attention SQL tests. Independent verifier reproduced browser flows on Chromium 153 at 390/761/768/800/1586 widths, SQL pagination/filtering and HTTP auth/CSRF boundaries using controlled adapters. PGlite is SQL evidence, not native concurrency/production evidence; local native harness remains blocked by UID namespace. Native backend/legacy checks run in the existing Outreach checks PR workflow.

Observed defects corrected: filtering omitted events beyond initial 50; attention pagination timestamp ties; horizontal overflow at 761/768; native Escape could dismiss pending create; mobile footer labels touched. Final exact commit/digest and verifier result are recorded in the PR. Screenshots use explicitly synthetic data. No real projects or capabilities were imported.

Delivery status at preparation: production remains backend 1.0.2. This screen is not yet deployed and real ChatGPT menu opening is not yet verified. Release confirmation requires deploying the reviewed revision, live authenticated source_digest readback, and opening the resource in the actual supported host. Remaining product stages: full project workspace, Materials/History/Capabilities, real skill/MCP imports, separately configured execution runtime.


## ACTIVE_CONTRACT — revision 4, release and private plugin

Authorization: user 2026-10-01 13:53 MSK, «Сделай 1 и 2. 3 с меня». Execute step1 release PR33 in existing Tg-mcp/Timeweb and step2 save private «Совместная работа» plugin with existing MCP. Step3 actual UI opening/evaluation in ChatGPT web/desktop belongs to Roman; do not perform it or claim its PASS.

Immutable source: remote head7f2d36611e72808a7778d9563c85e6d070f05a97, tree357083bbc770260a88b41c3969b4747b361ea2c2; backend1.0.3 / UI1.0.0; expected digest f4217e045c20d2f968391391917e8c5b6a8de38232c21ca005461f0cc273d08c. QA local PASS; Outreach checks36848003096 postgres110322675498, 345 tests PASS zero skips, same digest. Current PR readback: open, ready, mergeable, main27e34a0fb52bf20a11778792cf0b139663ace000 unchanged. Current authenticated runtime baseline:1.0.2 /0095d7142ef7b1c80c6db90aebbe3e12155fbf45e8381d50860fa282e1aa1a79.

Operation prepared: merge PR33 with expected headSHA and normal merge method; existing Timeweb deployment; verify live module version/digest and read-only resource metadata. No DB migration, worker/schedule activation, real project import, new credentials or permission expansion. Recovery uses previous source revision without deleting roman_workspace data; release must not be reported from /healthz alone.

Plugin preparation: lookup existing registered MCP/app identifier before binding; preserve auth/hosting and PRIVATE audience. Existing package not yet saved by this agent. Account-plugin personal listing returned no results; plugin directory search absence is not an access denial. Backend and plugin release operations require readback before claiming complete.

Stage: release IN_PROGRESS; plugin NOT_STARTED. Next: merge/readback, runtime digest observation, verified dependency binding/package save; return plugin link to Roman for step3.


Release readback: PR33 merged normally, merge commit7aca0136ab815bb15490ad83844020cf7e490a50; GitHub fetch_pr confirms merged/closed. Existing authenticated MCP confirms enabledtrue/version1.0.3/source_digestf4217e045c20d2f968391391917e8c5b6a8de38232c21ca005461f0cc273d08c/authhost/worker_readyfalse. Step1 VERIFIED. Actual app menu/UI rendering still belongs to Roman.

Step2 BLOCKED_INPUT: exact registered FullaccessbdYCS app identifier unavailable from connected MCP tool outputs, personal package listing and plugin directory lookup. ChatGPT cloud browser shows sign-in; secure browserAuth request returned declined, so no further auth request was made. Do not create a substitute/empty account plugin or weaken/change auth. Prepared package presentation in plugins/shared-workspace; required binding not guessed. Next user input: non-secret plugin/card URL or exact registered app ID for FullaccessbdYCS. With that input, validate dependency binding, archive, save PRIVATE through Plugin Creator and read back stored metadata/files; no repeated permission request required.
