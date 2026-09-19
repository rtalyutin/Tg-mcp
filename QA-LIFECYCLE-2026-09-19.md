# Independent lifecycle acceptance — 2026-09-19

**Verdict: PASS for the local checked publisher/lifecycle gate, version 0.7.0.**

Independent executor: `/root/verify_lifecycle`, separate from the runtime author. This executor wrote only its held-out tests and evidence; it did not edit application code or commit. Synthetic fixtures and loopback HTTP only. No real Telegram, Timeweb, OAuth or deployment action was performed.

## Object and evidence identity

- Base commit: `78019b6bedde9749e4a66c7cf9cb73aa15845ca0` plus the working-tree 0.7.0 implementation.
- Accepted runtime identity: `source.sha256` includes all eight `src/*.ts` files, package/lock files and both TypeScript configurations. SHA-256 of this manifest: `cea7aa0b34208c615509730c5d3d7b54c6098d703c0b5dd28fbbc079950d6938`.
- Built JavaScript identity: `build.sha256`; manifest SHA-256 `ed10bd3a52376bc96b895d3fe2de3793049734e31fd0c868234ca22e74015419`.
- Executed test identity: `tests.sha256`; manifest SHA-256 `17d56cbb4423e6b18f11667bf946ba37ff41f71fe4bfe31cab40aa7b31bd60dd`.
- All accepted runtime hashes were rechecked successfully after execution (`hash-check.txt`, 2026-09-19T14:16:11Z). Documentation was being edited independently and is deliberately excluded from this runtime gate.
- `source-before.sha256` and `revision-before.txt` are initial inspection records, taken before the author's final waiter-generation fix. They are not the accepted runtime identity; every reported check below used `source.sha256`.
- Environment: Linux, Node `v24.19.0`, npm `11.9.0`; repository's installed dependencies and native Node TypeScript execution. Built child processes imported the emitted `.js` modules.

## Executed checks

Commands are run from the repository root. Evidence filenames below refer to `verification/2026-09-19-lifecycle/`.

| Command | Actual result | Evidence |
| --- | --- | --- |
| `node --test test/lifecycle-heldout.test.ts` | 10 passed, 0 failed/skipped/cancelled | `heldout.txt` |
| `npm test` | 89 passed, 0 failed/skipped/cancelled, including the 10 independent cases | `full-suite.txt` |
| `npm run check` | TypeScript check completed without errors | `check.txt` |
| `npm run build` | JavaScript build completed without errors | `build.txt` |
| `node --test verification/2026-09-19-lifecycle/built-signal-check.mjs` | 3 passed, 0 failed/skipped/cancelled | `built-signals.txt` |
| `sha256sum -c verification/2026-09-19-lifecycle/source.sha256` | All 12 entries OK after the checks | `hash-check.txt` |

## Criteria and observations

| Criterion / risk | Independent scenario and observed result | Evidence |
| --- | --- | --- |
| Atomic registration and channel ownership before awaited rights check | A held preflight exposed the canonical `IN_PROGRESS` attempt immediately. Same-attempt/story replay returned it; conflicts returned their specific codes; another story returned `BUSY`. Only one preflight and zero sends occurred. A denied preflight remained registered and replay did not recheck. | Held-out tests 1 and 7 |
| Rights preflight prevents unauthorized publication | Checked SDK publication with posting rights denied ran exactly `getMe`, `getChat`, `getChatMember`, returned `TELEGRAM_NOT_READY`, and never called `sendMessage`. Disabling the publication flag while preflight awaited also prevented a send. | Held-out tests 3 and 7 |
| Status is read-only and fresh; concurrent checks coalesce | Three consecutive SDK status reads reflected allowed/denied/restored rights and made three complete read sequences with zero writes. Gate-level concurrent reads ran one checker; the next completed read ran another. Result mutation did not alter another caller or the snapshot. | Held-out tests 5 and 6; author coalesced SDK scenario in full suite |
| Failed send invalidates pending readiness and stale results cannot restore ready | An SDK status read was held in `getChatMember` while publication failed with HTTP 403. Releasing the earlier successful read produced `telegram_ready=false` and null metadata. Attempt replay preserved `BOT_FORBIDDEN`; a subsequent explicit status read could revalidate successfully. | Held-out test 8 |
| Stop prevents new work and late rights results cannot enable sends | Stop while preflight awaited did not resolve early, denied a new attempt, retained `IN_PROGRESS` for replay, then registered `REJECTED/SHUTTING_DOWN` after the late successful rights result with zero sends. Gate-level stop permanently prevented refresh. | Held-out tests 2 and 5 |
| Stop retains IDs and uncertainty; no subsequent parts/retries | Core publisher preserved a confirmed first message and `UNKNOWN` second part with one unattempted part. SDK stop during first send retained message ID 733, returned `PARTIAL/SHUTTING_DOWN`, and sent no second or third part. Lookup/replay remained available before close, without more Telegram calls. | Held-out tests 4 and 9 |
| Actual signals drain the active request and MCP response before exit | Built child received actual SIGTERM while `sendMessage` was held: response confirmation produced `PARTIAL`, ID 614, two remaining parts, complete MCP response, then clean process exit. Another child received actual SIGINT: bounded Telegram timeout produced `UNKNOWN`, uncertain part 1 and clean exit. Repeated signals resulted in one close only. Both made exactly one send with exact first-part text. | Built signal checks 1–2 |
| Local-only boundary and safe default entrypoint remain intact | Disabled/stale publication requests made no Telegram calls. Checked factory rejected real Telegram/non-loopback/HTTPS fixture roots and readiness override. Actual built default `main` exposed no publication tool, reported both flags false and exited cleanly on SIGTERM. | Held-out test 10; built signal check 3; existing transport regression suite |
| Text/order, no automatic retry and in-memory identity contract remain intact | Exact first and second text parts and order were asserted in held-out tests; every uncertain/partial result explicitly forbade automatic retry. Existing full suite's formatter, instance-change, deduplication, transport and Telegram adapter checks remained green. Runtime inspection found no new persistence mechanism. | Held-out tests 4 and 9; built signal checks; full suite |

## Defects, limits and handoff

No observed mandatory-criterion defects, blockers or accepted exceptions in this local gate. Tests establish local mock behavior and actual process signal handling; they do not establish real Telegram permissions/delivery, hosted behavior, OAuth readiness or durable recovery. In-memory deduplication still ends with the process lifetime. No external publication attempt was created.

- `handoff_schema`: `FEATURE_HANDOFF/1`
- `handoff_digest`: `880ed9d2dc0004f39250f4a5c3739840cc1f9c4b37edf78b652dc787f5aa44e4`
- `artifact_revision`: base commit plus the accepted source/build/test manifests above
- `evidence_status`: `VERIFIED`
- `gate_verdict`: `PASS`
- `operation_status`: `NOT_STARTED` for real external publication/deployment
- `next_action`: coordinator may complete its already authorized version/report handoff; this QA verdict adds no publication or deployment authorization
- `return_to`: `/root`

Any later runtime/package/configuration change invalidates the affected checks and requires a bounded rerun against the new fingerprint.
