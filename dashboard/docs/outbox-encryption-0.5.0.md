# Encrypted pending outbox — local implementation

`collectAll` now requires a 32-byte `outboxKey` supplied in memory. Pending
packets use AES-256-GCM with a fresh 12-byte random nonce, a 16-byte tag and
authenticated schema marker (`dashboard-outbox/2`). The packet, cursor and
content digests are inside ciphertext. Filenames still expose a source UUID
and hash of the batch key. Acknowledgements keep the previous metadata-only
format and contain no event text.

The caller supplies the same key on restart and on rebind. Missing or incorrect
keys, altered ciphertext/tag and a legacy plaintext pending packet cause the
worker to stop before applying the packet. There is no silent plaintext
migration. Drain old synthetic/plaintext outboxes separately before selecting
encrypted mode; never add real texts to a plaintext outbox.

Key generation, storage, backup, rotation and recovery are **not selected**.
An environment variable or repository file is not prescribed. Loss of the key
means pending packets cannot be recovered; compromise of the key exposes them.
The worker is still designed for one process, and Timeweb durable storage and
native PostgreSQL have not been checked. Do not enable collection of real
history until the key mechanism and these gates are resolved.

Local checks cover absence of plaintext markers on disk, authenticated
readback, wrong/missing key, tampering, rebind, crash retry, and an independent
round trip via the official MCP client. The primitive usage follows
[Node.js crypto API (v24)](https://nodejs.org/download/release/v24.16.0/docs/api/crypto.html):
`createCipheriv`, `getAuthTag`, `createDecipheriv` with an explicit 16-byte
authentication tag, and `setAAD`.
