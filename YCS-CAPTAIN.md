# YCS captain and organizer API

Roman authorized publishing the captain cabinet on 2026-10-09. This package
adds the prepared API v3 and retention cleanup to the existing Tg-mcp process
and HTTP port. It does not start another server, results collector, database,
bot sender or Telegram notification flow. The runtime is disabled by default.

## Preserved source and routes

`ycs-dota/captain-manifest.json` pins the captain source from yarcyberseason
`ed0503c0529363cf37b9b7d6efa14b63569e2937`. Fourteen added modules/assets and
two existing Dota assets form this closure. The separate collector manifest
and fingerprint are unchanged. Build checks both manifests and their imports.

Organizer partner assignments are synchronized with `YCS-Partners-2026-10-03-1.xlsx`,
version 3 updated 9 October 2026. Tournament-wide support includes Torrefacto and
Redragon; the three confirmed final partners are scoped to `final-1`. Eight
partners still await an exact match assignment. Sporting fixtures, results,
caster/channel unknowns and the collector package are unchanged.

| Route | Authentication and behavior |
| --- | --- |
| `POST /api/captain` | Telegram Ed25519 initData for the configured bot; private access/chat/time/result claims |
| `POST /api/orgs/login` | Organizer login/password; returns an eight-hour memory-only bearer session |
| `GET /api/orgs/matches` | Organizer bearer; published table across five tournaments |
| `GET/POST /api/orgs/captains` | Organizer bearer; assignments and agreement/claim state, never chat contents |
| `POST /api/orgs/logout` | Revokes that organizer session |
| `GET/HEAD /healthz/ycs-captain` | Public safe version, source revision, package fingerprint, activation and cleanup state |

All API responses are no-store. Disabled or incompletely configured captain
runtime returns 503 `captain_not_configured` for `/api/captain` and all
`/api/orgs/*` routes. Tg-mcp did not previously serve the organizer API.
The health status is available even while disabled and never includes bot/user
IDs, usernames, messages, registry contents, credentials or exception payloads.
`/healthz` and `/healthz/ycs-dota` retain their existing meaning.

One service instance handles captain requests, organizer requests and cleanup.
Its routes retain their own authentication and remain available when the
unrelated PostgreSQL/MCP gateway fails. Cleanup runs at startup, then 60 seconds
after each pass without overlap. Shutdown rejects new captain work and waits
for active API requests and cleanup. Organizer sessions are lost on restart;
one process/replica is required for the existing in-memory session/rate limits.

## Configuration and activation gates

Keep the current native Node.js 24 build and production start commands:

```text
npm ci --include=dev --ignore-scripts && npm run build
npm run start:production
```

Set configuration only in the existing backend's server environment. Never
put secrets in Git, frontend variables, URLs, command history or chat.

| Setting | Requirement |
| --- | --- |
| `YCS_CAPTAIN_ENABLED` | Explicit `true` to activate; absent or `false` stays disabled |
| `YCS_CAPTAIN_BOT_ID` | Verified numeric ID of the actual YCS Mini App bot, matching its Serverless project |
| `YCS_CAPTAIN_ENCRYPTION_KEY` | Stable secret of 32 random bytes represented by 64 hex characters |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Existing server S3 credentials with conditional read/write access to the captain object |
| `YCS_CAPTAIN_BUCKET` | Optional; defaults to existing `e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04` |
| `YCS_ORGS_LOGIN`, `YCS_ORGS_PASSWORD` | Required for organizer login; no defaults and no connection to MCP credentials |
| `YCS_ORGS_ALLOWED_ORIGIN` | Optional exact organizer frontend origin; default is `https://xn--90aiaibl0ahlel5n.xn--p1ai` |
| `YCS_CAPTAIN_WINDOWS_JSON` | Approved `matchId -> {start,end}` windows with explicit ISO offsets; no guessed schedule |

The adapter requires valid bot ID, encryption key and AWS credentials before
loading the service or starting cleanup. Missing organizer credentials leave
organizer login unavailable. Missing windows block agreement with
`window_unavailable`; they do not block chat, reading or cleanup. Invalid window
JSON fails the affected API operations closed, but cannot disable cleanup.
The collector's `YCS_DOTA_RESULTS_IMPORT_ENABLED` setting is independent and
must not be changed to activate or disable this cabinet.

The prepared frontend still requires Telegram Serverless. Set its public relay
target `YCS_CAPTAIN_SERVICE_URL` to
`https://rtalyutin-tg-mcp-4776.twc1.net/api/captain` when preparing that project.
The frontend organizer base `VITE_YCS_ORGS_API_URL` is the same origin without
an API path. These addresses are public configuration, not credentials.
The captain API deliberately rejects browser Origin headers: it is a
server-to-server relay target, with no direct browser transport or fallback.

Backend code can be published disabled before the following gates are closed:

1. Confirm the selected bot's numeric ID and Serverless project. Preserve its
   existing handlers/modules when publishing the captain relay; do not replace
   the complete bot from a partial local directory.
2. Supply and retain the encryption key and organizer credentials through the
   existing server secret mechanism. Verify S3 ETag/If-Match/If-None-Match and
   private/no-store writes for the exact captain key in the permitted environment.
3. Verify versions, backups and Object Lock for that key before promising no
   conversation archive. Do not change public result storage policy for this.
4. Publish and verify the Serverless relay and frontend, including real signed
   Telegram access for two assigned captains and organizer login. Before any
   Mini App URL switch, satisfy CAP-HOST-CONTENT-1: current tournaments,
   archives, rosters, results, assets and dynamic updates remain accessible.
5. Configure approved match windows and verify both confirmations, then official
   completion cleanup and status readback. A result claim alone must not close chat.

Deployment, runtime activation, working Serverless transport and complete
end-to-end acceptance are separate observations. `enabled:true` means the
runtime started; it does not prove storage access or successful user login.

## Storage, deletion and recovery

The only writable cabinet object is `captains/dota2-autumn-2026.json`, schema v3
inside an AES-256-GCM envelope. The existing public `results/*` objects are
read-only inputs to this module. ETag CAS and retained commit receipts handle
concurrency and uncertain PUT responses; invalid ciphertext or a wrong key
fails closed without resetting data. Capacity is bounded at 8 MiB of clear
state; excess writes fail without evicting older conversation messages.

Chat survives reads, a week offline, restarts and captain replacement. Official
completion atomically closes the chat and removes its messages, message
receipts/fingerprints and chat audit from the current object. The closure is
sticky against stale retries and source rollback. Assignments, agreed times
and separate result claims remain. Older S3 versions or backups are outside
the application's current-object cleanup and must be checked at release.

Keep the encryption key recoverable outside this repository. Rotating it
without an explicit re-encryption operation makes existing state unreadable.
Do not delete/reset the object or restore an old version to fix a failed read:
that could undo rights, agreements or closure and resurrect deleted chat.
If a write times out, read back before an independent retry; the client retains
the same request ID for the same command.

To stop cabinet requests, set `YCS_CAPTAIN_ENABLED=false` and restart the same
app. This also stops automatic retention cleanup: it is an emergency stop,
not a way to satisfy deletion obligations for already stored conversations.
Keep the collector setting unchanged. Correct the underlying issue and restore
cleanup without reverting saved closure or overwriting the cabinet object.

Local checks use synthetic Telegram keys/accounts and an S3 transport double.
They cover encryption, CAS, auth, retention and runtime isolation but do not
prove production storage policy, live secrets or Telegram WebView behavior.
