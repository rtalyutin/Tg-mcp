# Source-event candidate extraction

`extractEventCandidates(db,{eventId,extractorVersion,extract})` accepts one
immutable source-event revision. A caller-supplied extractor receives the event
and returns up to 20 project/task candidates. Each candidate has an event-local
key, title and explanation; a task also has an optional expected result and
project title hints. Only that event is recorded as its evidence. No status,
progress, canonical ID or hidden flag can be supplied through this contract.

Candidates and a completion marker are saved atomically in
`dashboard.change_proposal`. The marker also records an empty result, so a
retry with the same event and extractor version does not call the extractor
again. New extraction behavior requires a new extractor version. A concurrent
different output for the same event/version fails with `EXTRACTION_CONFLICT`.
The marker digest detects partial or changed stored candidate rows.

Extraction alone creates no project/task records or memberships; title hints
are not treated as identity. The separate internal resolution step is described
in `candidate-resolution-internal.md`. Neither module contains a model client
or sends conversation text externally. Validation checks structure and
provenance, not the semantic truth of an extractor's claims. The synthetic
test ingests a message through the existing import path and verifies the
proposal and empty-result paths in PGlite.
