# OwnSite portfolio module

OwnSite uses the existing Tg-mcp PostgreSQL pool. All portfolio metadata, values,
and public contacts live in the isolated `ownsite` schema; public reads never query
the workspace or outreach schemas. The module does not close or replace the pool.

## Runtime integration

`createOwnsiteGateway(pool, credentialId, contacts?)` is exported from
`src/ownsite/gateway.ts`. The integration enables it with `OWNSITE_ENABLED=true`
and binds its owner tools to `OWNSITE_MCP_CREDENTIAL_ID` (or the existing permitted
snapshot credential). The identifier must be a UUID. Existing server authentication,
host, TLS and origin checks must run before invoking this gateway.

No new PostgreSQL instance or connection string is required. The existing database
role needs permission to create and use the `ownsite` schema. Initialization runs a
transaction under an advisory lock. A configuration flag keeps migration and serving
opt-in. This code has only been exercised locally; enabling the flag in the deployed
service performs the actual migration.

The existing site keeps its server renderer and same-origin browser `/api` routes.
Its server reads these backend routes over HTTPS:

| Route | Public result |
|---|---|
| `/ownsite/api/works` | Published cards in approved order |
| `/ownsite/api/works/:slug` | One published card, otherwise 404 |
| `/ownsite/api/contacts` | Approved public phone and email links |
| `/ownsite/readyz` | `{"status":"OK"}` after querying and validating public cards |

Only GET and HEAD are accepted. Query parameters, public writes, arbitrary tables,
and unknown routes are refused. Responses have no CORS grants and are not cached.
Database errors return a generic 503 without SQL, credentials, or private content.
The enclosing server provides a separate bounded public-read rate limiter: 120
requests per minute per resolved client IP, at most 4096 active entries per process.
Requests from the site renderer share its egress IP. This limiter does not consume
the existing MCP admission queue or grant access to any protected route.

## Metadata constructor

| Table | Responsibility |
|---|---|
| `entity_types` | Entity class definitions |
| `entities` | Stable ID, class, unique class-specific slug |
| `entity_parameters` | Parameter name, title, scalar data type and nullability |
| `entity_parameter_values` | One typed scalar or JSON value per entity and parameter |
| `site_settings` | Technical seed revision only |

Composite foreign keys require the entity class to match both the entity and parameter,
including parameter data type and nullability. Checks require one populated typed
column, or an explicitly allowed null. Links, reveal sections and tools require JSON
arrays. Application validation checks the expected field shapes, bounds, HTTPS links
without embedded credentials, and local asset paths.

Metadata lives in PostgreSQL and is read before writes. Initial field definitions
cover the existing site contract. Additional metadata does not automatically become
public: the DTO copies only approved field names and validates nested objects against
strict schemas. A malformed published card fails the public read closed.

`show` must be a stored boolean true. False, null and a missing value all hide a card,
including direct requests by slug. Public DTOs omit `show`, catalogue ordering,
metadata, and all unapproved fields. The approved nine-card snapshot is seeded only
when each entity is newly inserted; YCS and Dashboard are initially public. Restarts
do not replace edited values, republish hidden cards, or restore deleted parameters.

Public contacts use the same constructor: entity class `portfolio-contacts`, singleton
entity `public-contacts`, and nullable text parameters `phone` and `email`. No contact
domain values are stored in `site_settings`; public reads select only these two
parameters of that singleton. Null, absent, and invalid contact values are omitted.

Initial contacts are `+79065253445` and `info@yarcyberseason.ru`. Explicit valid
configuration may replace these defaults for first initialization. Existing settings
are preserved on restart. An undefined environment value uses the approved default.

## Owner tools

`ownsite_list_works` accepts `{}` and returns the nine current cards plus constructor
metadata. `ownsite_update_work` updates selected fields of one existing card:

```json
{
  "id": "ycs",
  "patch": { "summary": "Updated approved summary", "show": true }
}
```

The gateway independently checks the caller credential against its configured owner.
The integration must also authenticate that credential before passing it to `callTool`.
Patches reject unknown keys and unsafe URLs, lock the entity, validate the resulting
card, and commit all fields together. No create, delete, bulk overwrite, public
mutation, publication scheduler, or private-workspace read is provided.

## Local verification

```sh
node --test test/ownsite.test.ts
npm run check
```

Four PGlite/HTTP tests cover the public DTO, approved contacts, all hidden states,
owner credential separation, restart preservation, constructor constraints, atomic
updates, unapproved fields and nested data, GET/HEAD, readiness, and generic failure
responses. PGlite exercises PostgreSQL constraints; production PostgreSQL/Timeweb
deployment is a separate operational check.

## Delivery state — 2026-10-02

ACTIVE_CONTRACT: user accepted the existing Tg-mcp/PostgreSQL backend, isolated
metadata constructor, retained OwnSite SSR, approved nine cards and owner MCP
control. Preparation and local verification are in scope; production migration
and deployment have not been performed. Existing workspace/dashboard sources and
the frontend's visual assets remain unchanged.

TASK_STATE: implementation and local checks complete; changes prepared for review
before remote publication. The module is disabled until `OWNSITE_ENABLED=true`.
Run Tg-mcp first, activate and check its public routes, then switch the frontend.
The frontend Docker image now requires `PORTFOLIO_API_URL`; do not switch it before
the optional backend is operational.

Author checks on the prepared code: `npm run check`, `npm run build`, and
`node --test --test-concurrency=2 test/*.test.ts`: 183 passed, 8 skipped because their
separate PostgreSQL test configuration is unavailable. The frontend suite including
the cross-repository HTTP/SSR test passed 22/22. These are local results, not
evidence that Timeweb deployed the code or migrated its database.

Independent local acceptance: VERIFIED / PASS on the final runtime files. Checks
used real AccessStore/Argon2 credentials, the mounted outreach gateway, the remote
frontend adapter and SSR. They covered owner separation, hidden/absent/null `show`,
private metadata exclusion, rejected malformed patches and atomic slug-conflict
rollback, constructor constraints, disk close/reopen preservation, and contacts.
An email containing a mailto query was found and fixed; its value is now omitted.
Database failure returned generic OwnSite/SSR 503 responses while existing gateway
health and authenticated tools continued to work. The actual production entrypoint
was also run through the `pg` driver against a local PGlite socket: an incompatible
OwnSite table disabled only the optional module; the parent gateway started and
retained its existing tools. Invalid startup configuration was rejected.

This acceptance covers local PGlite, HTTP, SSR and production-entrypoint behavior.
Live PostgreSQL, Timeweb, TLS and deployment have not been verified. Docker startup
configuration was checked; the container image was not built. Visual acceptance
was not repeated because visual assets did not change.
