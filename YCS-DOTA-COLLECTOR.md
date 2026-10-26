# YCS Dota match collector

Roman authorized moving the existing results/MVP collector into `Tg-mcp` on
2026-10-09. This module runs alongside the existing production backend; it
does not replace the Telegram, outreach, dashboard or workspace services.
The website and Mini App remain on their current frontend hosting and read
their results directly from the existing Timeweb S3 bucket.

## Source and preserved behavior

The imported code is from `rtalyutin/yarcyberseason` revision
`32e4f2e10b37f518dde99f3dd54d83abbafd8194`. Its runtime modules, shared
normalizers, MVP formula, tournament fixtures and player identities are in
`ycs-dota/`. This is the active writer location; source changes to those data
must be transferred here and checked before the collector uses them.

- OpenDota league: `20164`, tournament: `dota2-autumn-2026`.
- S3 endpoint: `https://s3.twcstorage.ru`, region: `ru-1`.
- Existing bucket: `e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04`.
- Objects: `results/dota2-autumn-2026.json`,
  `results/dota2-autumn-2026-mvp.json` and
  `results/dota2-autumn-2026-mvp-cache.json`.

The five-minute timer schedules its next check after the current run finishes.
Before the first published fixture it makes no OpenDota or S3 calls. During
the published tournament period it discovers league maps. After the period
ends it restores the cache and retries only unresolved maps; it does not
discover another tournament. Incomplete or ambiguous results are not turned
into official wins, and missing replay data is not scored as zero. Existing
object schemas, MVP formula and confirmed-result validation are preserved.
There is no public import trigger, bot notification or GitHub writer.

October11's confirmed Easy–Leto BO1 uses official map9038793515. The extra
API record9038788632 is incomplete and has no established disposition. A
complete organizer-confirmed map set now selects sports API candidates by ID,
so that additional record is informative rather than an unresolved ambiguous
series. Its original raw source/MVP pending state is preserved. Incomplete
organizer map sets remain ambiguous; contradictory official map data still
fails the import. Collector source is pinned toff3b2a5949bd7d553508c86be4d2063a07756489;
captain source and the existing worker activation default are unchanged.

## Activate on the existing Timeweb backend

Keep the existing native Node.js 24 build and start commands:

```text
npm ci --include=dev --ignore-scripts && npm run build
npm run start:production
```

Set these values in the **server environment of the existing Tg-mcp app**:

| Variable | Value |
| --- | --- |
| `YCS_DOTA_RESULTS_IMPORT_ENABLED` | `true` |
| `AWS_ACCESS_KEY_ID` | Existing S3 writer access key |
| `AWS_SECRET_ACCESS_KEY` | Existing S3 writer secret key |

No new app, bucket, database or OpenDota key is required. The credentials must
already have access to the three listed objects. Keep them out of Git, client
bundles, startup commands and chat. Preserve the app's unrelated variables.
If writer keys are already configured, reuse them. Without the flag or keys,
the collector stays disabled and existing backend behavior is preserved.

Use one writer process/replica, without overlapping enabled deployments.
Stop any previous writer before enabling this one. Serialization protects one
process; it is not a distributed lease. The old `yarcyberseason` worker's
automatic enablement is removed as part of this relocation, but a code change
does not stop an already running instance.

The collector does not need the outreach database. A configured collector
continues in a degraded backend if the database fails; existing unavailable
routes remain unavailable. Shutdown cancels the timer and aborts in-flight
collector network requests before closing the process.

## Readback and recovery

`/healthz` still means HTTP liveness only. `GET /healthz/ycs-dota` is the
collector's separate read-only status. It reports module version, source
revision and package fingerprint, whether it is enabled and configured, along
with its state and attempt/success timestamps; it never exposes keys.
Source publication, runtime deployment and successful S3 import are distinct.

After deployment, check the collector status on
`https://rtalyutin-tg-mcp-4776.twc1.net`, then verify an actual match through
OpenDota → S3 readback → website/Mini App. A waiting state before kickoff is
expected; it does not prove a completed import. The runtime tests use local
doubles and do not claim live S3 write verification.

To stop new imports, set `YCS_DOTA_RESULTS_IMPORT_ENABLED=false` and restart
the same app. Existing S3 results remain available. If an import write has an
unknown outcome, read the objects before retrying; do not restore older object
versions automatically. Reverting code does not revert published match data.

## October 10 result and MVP correction

This package now mirrors source e428bf265d0653ceebace677cbc7b38790c9a86c.
Three approved R1 outcomes publish through the existing writer before league
API discovery, with CAS/readback. Technical no-play remains without MVP.
Missing played-map per-player MVP is the current tournament's complete REAL
player-map average ×1.15/0.85; estimates are excluded from that average and all
are recalculated on new real data. Real recovery replaces the estimate.
The explicit Tech map9037645797 presently has no verified ten-account binding,
so its individual awards are pending. No raw metrics/zero/baseline is fabricated.
Discovery failure permits known-ID retries while keeping discoveryPending true;
it cannot produce an automatic unverified series. Both collector and captain
manifests pin shared updated source bytes; private captain data is preserved.
Source publication and health/runtime/S3 readback remain separate release gates.

## October11 tournament update

The approved R2 draw and full R1 results are bundled from source
`202f26e3260f13f0c125bfdc0c65124187956bd6`. The ten actual WAYPROD–Fummo
players can now be read using verified OpenDota team IDs. The official Easy–Leto
BO1 confirmation uses full card9038793515; incomplete9038788632 stays pending
without scores or a guessed exclusion. Screenshot-confirmed R2 card9039436432
publishes the Aegis win and retries the exact ID; absent account bindings mean
no individual MVP awards yet. Seven other R2 fixtures have the agreed11–12Oct
Moscow matching window and no invented start time. Captain private state,
single-writer guards and the runtime worker's existing activation default are
preserved; the two manifests pin shared source data separately.

## October26 grand-final MVP ingestion

User authorized ingesting grand-final maps. The package now mirrors completed
source eaa1d6166e027cd0440b38f9b71db427e5e291bb. Both collector and captain
manifests update only their shared tournament data hash/schedule source pin;
scoring/runtime code and private state are unchanged.

The observed runtime fingerprint f2e5881701e4c33e616f11c46ef53a15711703750e2c0d91e6008185dbf119e0
is from f19fd8c9, before lower-final result/finalist synchronization. Cache4340
contains parsed ten-player sources for9060104275,9060210847,9061493228,
9061646304,9061715579, all previously unmatched. The final also needs a
calendar-day matching window because its first map started17:45:54MSK,
before the importer's implicit18:00 cutoff for an unappointed match.
No appointment is invented; the window is25October00:00–26October00:00MSK.

Local replay against those actual cached sources produces all50 real player-map
contributions and no ingestion-pending IDs. Independent Python rational arithmetic
matches every new exact score and verifies prior real contributions unchanged.
Grand-final MVP projection: uma turman(account1428538045),117.58 over3maps.
Three older unresolved cache entries and existing estimates remain unchanged.
Typecheck/build/assets PASS. Targeted runtime/captain/MVP tests86/93; the same
seven failures reproduce on untouched parent4b8da4ac (stale test fixtures).

Release: rebuild the EXISTING Tg-mcp application from main using its unchanged
native build/start commands. Keep one writer, existing credentials and activation
flag. Check /healthz/ycs-dota against this manifest's packageFingerprint, then
read public results and MVP snapshots: five IDs ready, no ingestion-pending IDs,
final3:0, grand-final MVP117.58. Publication of this source is not activation.
The cloud browser currently cannot access the Timeweb control-panel page.
If deployment is unknown, inspect health/snapshots before retrying. Rollback is
reverting only the shared fixture/manifests; never restore older S3 results
blindly, and do not start a second writer to bypass deployment access.
