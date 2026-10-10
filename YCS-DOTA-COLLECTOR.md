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
