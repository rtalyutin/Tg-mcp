# Codex desktop source probe — 2026-09-23

`npm run probe:codex --workspace=roman-dashboard-backend` runs locally on a
computer with `codex` in `PATH`. It starts `codex app-server` over stdio, performs
the documented initialization handshake, and uses only `thread/list` and
`thread/read`. It does not call Dashboard MCP, write to PostgreSQL, or print
conversation text or thread identifiers.

The probe explicitly lists all ten documented `sourceKinds`, both active and
archived stores, and follows each `nextCursor` to `null`. It enumerates twice
and requires identical ID sets, then reads every enumerated thread with
`includeTurns: true`. It returns counts only. Any list/read failure, repeated
cursor, duplicate ID, or changed enumeration fails closed.

This is a capability probe, **not a production collector** and not a proof of
all desktop history. It covers only the local App Server store visible to the
invoked `codex` installation/account. Two matching passes do not provide a
transactional snapshot; concurrent archive/move/delete or a separate store may
still affect completeness. `thread/read` can fail on an unsupported paginated
record. The probe makes this visible rather than marking the source complete.

Only after a real-machine probe and a check against the visible Codex desktop
session count should an adapter be built. The adapter must preserve stable
thread/turn IDs and revisions, handle edits/deletions and archived moves, and
use a full-enumeration strategy unless an actual watermark is established.

The ChatGPT source remains independent and blocked for automated live coverage:
the documented account export is request-based, not an authenticated daily
enumerate/read/watermark API. A search result is not a full export.

Official references checked 2026-09-23:

- https://learn.chatgpt.com/docs/app-server (initialization, `thread/list`,
  `thread/read`, pagination, archive and source kinds)
- https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data
  (ChatGPT account export)
