# YCS: anonymous browser-to-S3 intake on the existing runtime

This package is prepared for a draft pull request. It has not been activated on Timeweb, and
`setup-cors.mjs` has not been run against the production bucket. A production
S3 OPTIONS probe reported 403; browser PUT/GET and the production settings
remain release gates. Local fake S3 tests do not establish provider support.

## Package and route boundary

`src/ycs-player-intake/runtime.ts` adds only `/api/player/v1/intake` and its
slash descendants to the existing `production-main.ts` listener, ahead of the
captain API. It does not add a host, listener, account API, cookie or OAuth flow.
The MCP, collector, captain and health routes keep their existing entry point.
Shutdown stops admission and waits for accepted intake requests.

The seven backend/catalog files are byte copies of the reviewed YCS source.
`manifest.json` pins their SHA256 values and the separate CORS utility. The
build rejects missing, changed or extra closure modules. Do not modify a copied
module independently: update from the reviewed source and regenerate the
manifest after verification. The manifest identifies the copied file contents;
`sourceRevision` identifies published frontend source `8e7b01a`, while
`sourceBaseRevision` preserves the earlier implementation baseline.

Dependencies added here are `sharp@0.35.5` and the official
`@aws-sdk/s3-request-presigner@3.1143.0`, matching the existing S3 client.

## Local verification

Run on Node.js 24 from the repository root:

```sh
npm ci --include=dev --ignore-scripts
npm run check
npm run build
node --test test/ycs-player-intake.test.ts test/ycs-player-intake-cors.test.ts test/player-intake-verifier.test.ts test/ycs-captain.test.ts test/ycs-match-media-runtime.test.ts test/startup-http.test.ts
```

The new tests use loopback HTTP, synthetic credentials, injected S3 and
presigner fakes, and real Sharp. They exercise the actual vendored prepare /
complete handlers, filename allocation, retry, route isolation, MCP/health
preservation, request draining, CORS merge and failed/unknown outcomes. No real
S3 operation is needed for these tests.

The independent verifier is in `test/`, so the existing `npm test` glob also
discovers it. It always checks the manifest, bytes and import closure. When
the reviewed `../yarcyberseason` checkout is available, it also compares each
copied source file with that checkout; a standalone checkout reports that the
additional comparison is unavailable without skipping the manifest checks.

Release preparation on 19 October corrected two stale test expectations from
main: round 4 has a two-day window with two announced start times, and the
organizer view now contains 37 matches. The published tournament data and
runtime behavior were not changed. These two suites pass 26/26 locally; the
full PostgreSQL-backed workflow is required again before merging this PR.

## Deployment and activation on the existing service

The existing native commands remain valid:

```sh
npm ci --include=dev --ignore-scripts && npm run build
npm run start:production
```

The start command runs `dist/production-main.js`; keep `player-intake/` beside
`dist/` in the deployed checkout. The build check verifies that closure. Keep
the existing service settings, AWS keys, MCP authorization, database, captain
and collector configuration. Do not replace their settings with a minimal
intake-only environment.

| Setting | Intake behavior |
|---|---|
| `YCS_PLAYER_INTAKE_ENABLED` | Disabled unless exactly `true`; deploy code with `false` first. |
| `YCS_PLAYER_ORIGIN` | Exact website origin; default `https://xn--90aiaibl0ahlel5n.xn--p1ai`. No path or wildcard. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Existing server-only S3 credentials; never put them in browser code, Git, commands or logs. |
| `YCS_PLAYER_BUCKET` | Optional existing bucket override; otherwise `YCS_CAPTAIN_BUCKET`, then the existing bucket default. |
| `YCS_PLAYER_ENABLED` | Forced to `false` inside this adapter regardless of the external setting. Full profile APIs are not routed. |

Intake uses the existing `https://s3.twcstorage.ru` endpoint and
`private/player-profiles/v1/` prefix. The adapter does not alter bucket policy,
ACL policy, object lifecycle or unrelated object keys on startup.

After the draft change is reviewed, release on the same service with intake
disabled. An operator with the existing settings and S3 access then performs
the separate CORS operation below. Only after the CORS readback and real
browser preflight checks pass, set the two intake settings above and restart
the same service. Setting `YCS_PLAYER_INTAKE_ENABLED=false` and restarting
disables this route; it does not remove saved photos or revert bucket CORS.

Before declaring activation complete, verify the exact deployed build,
`/healthz`, the existing MCP/captain/collector behavior, and one authorized
browser prepare → S3 PUT → complete → S3 GET sequence from the configured
website. A successful complete response alone is insufficient: the browser
must download the final S3 JPEG and check its SHA256 before showing success.

## Explicit CORS operation — not a startup hook

Use the already configured server-side environment on the existing service.
The following commands are prepared instructions; they have not been run
against production in this change:

```sh
node player-intake/setup-cors.mjs --plan
node player-intake/setup-cors.mjs --apply
```

`--plan` reads and reports a proposed merge without writing. `--apply` reads
all existing rules, preserves them, appends one rule if needed, re-reads to
reject an observed concurrent change, writes once and verifies the full result
with GetBucketCors. Running the script without an option makes no S3 request.
Any denied or invalid read fails closed; only S3's explicit
`NoSuchCORSConfiguration` is treated as an empty initial rule set. A lost write
response is resolved by exact readback, otherwise the operation reports an
unknown result. There is no blind reset or automatic retry of an unknown write.

The additional rule has only the exact `YCS_PLAYER_ORIGIN` (the default website
above), methods `PUT`, `GET`, `HEAD`, and these allowed request headers:
`Content-Type`, `If-None-Match`, `x-amz-acl`, `x-amz-meta-owner`,
`x-amz-meta-fingerprint`. Existing rules are not narrowed or broadened. No ACL,
bucket policy or lifecycle API is called. Bucket CORS has no conditional CAS
write, so the operator must prevent concurrent CORS administration for this
brief operation; the pre-write re-read cannot eliminate a later race.

After readback, check S3 OPTIONS from the exact website with the actual signed
PUT headers. Confirm provider acceptance of conditional PUT and the signed
headers, private GET and conditional staging cleanup. These provider behaviors
remain unverified locally. If activation fails, disable intake first; preserve
the existing rules and investigate rather than resetting CORS.

## Transport and technical limits

| Request | Result |
|---|---|
| `GET /api/player/v1/intake/context?Dis=cs` | Intake availability, discipline and photo limits. |
| `POST /api/player/v1/intake/prepare` | JSON `{requestId, Dis, name, nickname, sha256, size, contentType:"image/jpeg"}` → opaque `ticket`, ISO `ticketExpiresAt`, `upload:{method:"PUT",url,headers,expiresAt}`. |
| Browser PUT of the canvas JPEG to `upload.url` | Bytes go directly to private S3 staging; send the returned headers. The browser supplies Content-Length. |
| `POST /api/player/v1/intake/complete` | JSON `{ticket}` → `{status:"finalized",requestId,photo:{filename,readUrl,readExpiresAt,sha256,size,contentType,width,height},stagingCleanup}`. No photo body is accepted by this HTTP route. |
| Browser GET of `photo.readUrl` | Private final JPEG; browser verifies its bytes and SHA256 before success. |

POSTs require the exact configured Origin and bounded JSON; API CORS grants
only that origin. TTLs are 300 seconds for the signed PUT, 900 seconds for the
ticket and 60 seconds for the final signed GET. Expiry values are ISO8601
strings. These short capabilities must not be logged or persisted as public
links. An arbitrary non-browser HTTP client can forge Origin; this anonymous
feature does not authenticate callers.

The source upload here is an already cropped browser JPEG, at most 10 MiB and
1,048,576 decoded pixels. Complete checks real S3 bytes, size, SHA256 and bound
metadata, then Sharp creates a 1024×1024 JPEG with metadata removed. The older
full-profile limits are not changed. Final filenames are `fio-nick.jpg` or
literal `??-nick.jpg` when name is absent; existing names allocate `-1`, `-2`
and so on using conditional S3 writes. No listing of other users' names or
account read/edit/reopen endpoint is exposed.

Keep `requestId` and all prepare fields immutable across recovery. They bind a
stable fingerprint and staging key at
`private/player-profiles/v1/staging/<opaque-UUID>.jpg`. Repeating prepare with
the same fields does not allocate a second final photo. After an unknown PUT
or complete result, first retry complete with the current ticket. Only
`upload_not_found` (409) permits retrying that same PUT; a PUT 409/412 is not
success and must be resolved through complete. Renew an expired ticket/PUT
with the same immutable prepare data when needed.

A durable receipt and bound final-file byte verification let complete recover
after a final commit timeout even when staging is gone. After finalization it
attempts only its own staging object's conditional deletion with a short
budget. `stagingCleanup` is `deleted` or `pending`; an orphan may remain if S3
cleanup fails, and deletion does not promise removal of historical versions.
Honest browser staging is canvas JPEG without original EXIF; final Sharp JPEG
always strips metadata. No new final-photo retention policy is introduced.

## Verification evidence for this draft

The frontend source was published on the existing website at
`https://xn--90aiaibl0ahlel5n.xn--p1ai/player/profile/?Dis=cs` and its new
anonymous form was observed live. Its 87 player-profile tests and build passed.
The native adapter passed `npm run check`, `npm run build`, and all 31
focused intake/CORS/captain/media/startup tests, including eight independent
adapter/CORS checks. A built production gateway
smoke test returned health 200, disabled intake 503, account API 404, preserved
readonly MCP, and exited 0 on SIGTERM. Production intake remains unmounted
until this draft is released and configured. No production CORS write or
photo upload was executed.

Publication plan: create draft branch `codex/player-intake-browser-s3` and a
draft PR against `rtalyutin/Tg-mcp` main `c306a641a7b5535aafbf93092c09bbf1be8bb536`.
Authorization is the requested player-card implementation/publication on the
existing infrastructure. This operation preserves reviewable source; it does
not merge main, restart Timeweb, enable anonymous intake or modify bucket CORS.
Promotion and live activation remain blocked by unavailable target settings
and the observed S3 preflight denial.

## Release authorization and remaining configuration

On 19 October the user explicitly requested release into the existing Tg-mcp.
PR 62 targets the existing main and its existing Timeweb application; no new
application, domain or bucket is needed. The code remains disabled by default.

For activation, open the existing app in Timeweb: Settings → Deployment settings → Edit
→ Variables, and set `YCS_PLAYER_INTAKE_ENABLED=true`. The website origin already has a safe
default; `YCS_PLAYER_ORIGIN=https://xn--90aiaibl0ahlel5n.xn--p1ai` is an optional
explicit setting. Existing server AWS credentials and bucket settings remain
in place. Save the variables and redeploy the same app.

In the existing bucket's CORS settings, add one rule while retaining the old
rules: exact origin `https://xn--90aiaibl0ahlel5n.xn--p1ai`; methods `PUT`, `GET`,
`HEAD`; headers `Content-Type`, `If-None-Match`, `x-amz-acl`,
`x-amz-meta-owner`, `x-amz-meta-fingerprint`. No public bucket access or wildcard
origin is required. The prepared script above is an alternative to the UI.

After saving CORS and redeploying, the configured website's request to
`/api/player/v1/intake/context?Dis=cs` must report `available:true`. A real
browser upload and final S3 readback are still required to verify activation.
