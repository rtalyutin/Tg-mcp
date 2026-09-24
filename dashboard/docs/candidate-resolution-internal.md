# Candidate identity resolution

`resolveProjectCandidate` and `resolveTaskCandidate` turn an extracted candidate
into one canonical project/task or an explicit deferred decision. The caller
supplies `resolverVersion` and an asynchronous `decide` function. It receives
the candidate, its source event ID, and the existing project/task identities
and task memberships, including effective hidden project flags. The input can
include hidden entities so that a newly observed mention can link to one; this
is an internal owner-side interface and must not be exposed through the import
role or a user-facing graph endpoint.

The decision is `create`, `link` with an existing ID, or `defer` with a reason.
A task creation or link must specify one or more existing project IDs. Linking
a task adds those memberships without replacing existing ones. Neither action
sets a state, progress, or visibility flag. A linked entity keeps its canonical
title and expected result; later wording remains in the candidate and history.
Each committed decision records the candidate ID, reason, resolver version,
entity ID and an append-only history entry. Repeating the candidate returns
the recorded identity without calling the decision function again. A deferred
decision writes nothing and can be revisited.

The resolver verifies the completed extraction marker and the candidate's
provenance. Before committing, it locks other resolver writes and rereads the
identity context. If it changed while the decision was made, the transaction
fails with `STALE_IDENTITY_CONTEXT` so the caller can decide again. The context
is capped at 1,000 projects, 1,000 tasks and 10,000 memberships; larger data
sets require a bounded retrieval design before enabling live projection.

This contract does not decide whether two mentions are truly the same item:
that is the caller's semantic responsibility. It also does not reconcile
deletion, changed wording, project removal or later message revisions.
Concurrent canonical writers outside this resolver's advisory lock require
their own coordination. No LLM client, external messages, owner endpoint or
native PostgreSQL concurrency test is included yet. The PGlite fixture checks
two projects sharing one task, replay, deferral, changed context and the agreed
global visibility rule.
