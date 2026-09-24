# Dashboard PostgreSQL roles (prepared, not deployed)

The existing outreach `DATABASE_URL` stays with outreach. Dashboard uses a
separate `DASHBOARD_DATABASE_URL` for the HTTP runtime. It must identify a
different, restricted login. The migration CLI uses
`DASHBOARD_MIGRATION_DATABASE_URL` and is run separately before enabling
Dashboard. The HTTP process reads the migration ledger but never migrates.

1. As a database administrator, create a dedicated `dashboard_runtime` LOGIN
   role. Set its password in the database/secret manager, never in Git. Do not
   make this role a member of the migration owner, a superuser or a role with
   rights in the `public` schema beyond the migration ledger. The migration
   owner must be able to create schema `dashboard` and the ledger in `public`.
2. Run `npm run migrate --workspace=roman-dashboard-backend` with
   `DASHBOARD_MIGRATION_DATABASE_URL` pointing to the migration owner. This
   command verifies migration checksums and applies any missing migrations.
3. As the migration owner, execute `dashboard/sql/grant-runtime.sql`. It grants
   only the import tables and read access to the migration ledger. It assumes
   that the `dashboard_runtime` role already exists. Reapply grants after
   migrations that add new runtime tables; review the corresponding verifier.
4. Supply `DASHBOARD_DATABASE_URL` for the runtime login, alongside existing
   outreach `DATABASE_URL`, `DASHBOARD_ENABLED=true` and the Dashboard bearer.
   The two URL strings must differ. Startup checks every migration checksum and
   the effective role privileges before exposing `/dashboard/mcp`; a mismatch
   leaves Dashboard disabled while outreach can start.

Runtime can read sources/checkpoints, write run metadata and immutable event
rows, and verify receipts. It cannot read or change owner projects, tasks,
visibility or proposals, delete event rows, create schema objects, or write
the migration ledger. Source registration is an administrative setup operation
and therefore uses the migration owner separately.

`dashboard/test/runtime-privileges.test.mjs` executes the grant SQL under
PGlite, switches to the restricted role, completes a synthetic import and
checks denied operations. This does **not** verify provider-specific Timeweb
role provisioning, TLS, separate network sessions, or native PostgreSQL.
Those checks remain necessary before enabling Dashboard or importing history.
