# Per-task assistant progress assessment

The owner chose an assistant estimate for each task on 24 September 2026.
`proposeTaskProgress(db, {taskId,eventIds,extractorVersion,assess})` is an
internal preparation step. It loads the task and at most 25 immutable source
events, passes them to a caller-supplied assessor and validates an integer
percentage from 0 to 100, a nonempty explanation and event IDs selected from
that input. The assessor can abstain with `progressPercent: null`; this leaves
the canonical task unchanged and creates no proposal.

A supported estimate goes to `dashboard.change_proposal` with task version,
percent, explanation and evidence IDs. Replaying the same assessment returns
the same proposal. A changed assessment for the same task version, input events
and assessor version fails with `PROGRESS_PROPOSAL_CONFLICT`. A task version
change while the assessor runs fails with `STALE_TASK`.

The owner chose assistant resolution of conflicting conversations on
24 September. `resolveTaskProgress(db,{taskId,resolverVersion,decide})` gives a
caller-supplied decision maker the current task, all current-version proposals,
their source events and the previously accepted assessment with its evidence.
The decision maker can synthesize a new percent and explain it with event IDs;
it need not pick one proposal or use the latest message. It can abstain with
`null` if the evidence does not support a choice. A supported decision updates
canonical task progress as `assistant_estimate`, increments the task version,
and appends an `entity_history` record with the explanation, evidence IDs,
considered proposal IDs and resolver version. New proposals, changed task
fields or versions while deciding abort the write. At most 20 current-version
proposals are considered; larger sets fail rather than silently truncate.

These modules contain no model client and have only been tested with synthetic
assessors, decisions and events. A caller that later uses a remote model must
separately decide where personal conversation text may be sent, control prompt
injection and check that event relevance and the percentage are semantically
sound. Referential validation alone cannot prove the estimate is correct.
