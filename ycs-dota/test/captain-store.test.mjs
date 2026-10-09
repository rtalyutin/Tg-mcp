import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CAPTAIN_MAX_BYTES, CAPTAIN_ENVELOPE_MAX_BYTES, CAPTAIN_BUCKET, CAPTAIN_STATE_KEY, createCaptainS3Store,
  emptyCaptainState, validateCaptainState } from '../backend/captain-store.mjs';

const env = { YCS_CAPTAIN_ENCRYPTION_KEY: '4a'.repeat(32) };
const id1 = '1'.repeat(64), id2 = '2'.repeat(64);
const event = (id) => ({ id, kind: 'identity_linked', at: '2026-10-08T10:00:00.000Z', teamId: 'a', actorUserId: '11', bindingGeneration: id1 });
const revision = (number, ids) => ({ ...emptyCaptainState(), revision: number, history: ids.map(event) });
const rejectCode = (promise, code) => assert.rejects(promise, (e) => e.code === code);
const aad = (bucket = CAPTAIN_BUCKET, objectKey = CAPTAIN_STATE_KEY, tournament = 'dota2-autumn-2026', version = 1) =>
  Buffer.from(JSON.stringify(['ycs-captain-state', bucket, objectKey, tournament, version, 'aes-256-gcm']));
function seal(state, context = aad()) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(env.YCS_CAPTAIN_ENCRYPTION_KEY, 'hex'), nonce, { authTagLength: 16 });
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  return JSON.stringify({ envelopeVersion: 1, algorithm: 'aes-256-gcm', nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
function open(body) {
  const e = JSON.parse(body), decipher = createDecipheriv('aes-256-gcm', Buffer.from(env.YCS_CAPTAIN_ENCRYPTION_KEY, 'hex'), Buffer.from(e.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(aad()); decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'base64')), decipher.final()]).toString());
}
function fakeS3() {
  let data = null, etag = null, writes = 0;
  const calls = [];
  const s3 = { calls, errorAfterPut: null, afterPut: null, getError: null, omitEtag: false,
    async send(command) {
      calls.push(command);
      const input = command.input;
      assert.equal(input.Bucket, CAPTAIN_BUCKET);
      assert.equal(input.Key, CAPTAIN_STATE_KEY);
      if (command.constructor.name === 'GetObjectCommand') {
        if (s3.getError) throw s3.getError;
        if (!data) throw Object.assign(new Error(), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        return { Body: Readable.from([data]), ETag: s3.omitEtag ? null : etag, ContentLength: Buffer.byteLength(data) };
      }
      assert.equal(command.constructor.name, 'PutObjectCommand');
      assert.equal(input.ACL, 'private'); assert.equal(input.CacheControl, 'no-store');
      if ((data && input.IfMatch !== etag) || (!data && input.IfNoneMatch !== '*'))
        throw Object.assign(new Error(), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      data = input.Body; etag = `"test-${++writes}"`;
      s3.afterPut?.();
      if (s3.errorAfterPut) throw s3.errorAfterPut;
      return { ETag: etag };
    },
    seed(body) { data = body; etag = `"test-${++writes}"`; },
  };
  return s3;
}

test('existing bucket stores authenticated ciphertext with unique nonces; CAS and readback retain updates', async () => {
  const s3 = fakeS3(), store = createCaptainS3Store({ env, s3 });
  const initial = await store.read(); assert.equal(initial.etag, null);
  const next = revision(1, [id1]); next.bindings.a = { username: 'private_captain', userId: '918234756123', generation: id1 };
  const first = await store.compareAndSet(initial, next, id1);
  assert.deepEqual(first.value, next);
  await rejectCode(store.compareAndSet(initial, revision(1, [id2]), id2), 'storage_conflict');
  const secondValue = { ...next, revision: 2, history: [...next.history, event(id2)] };
  const second = await store.compareAndSet(first, secondValue, id2);
  assert.equal(second.value.revision, 2);
  const puts = s3.calls.filter((call) => call.constructor.name === 'PutObjectCommand');
  assert.equal(puts[0].input.IfNoneMatch, '*'); assert.equal(puts[2].input.IfMatch, first.etag);
  assert.ok(puts.every((put) => !put.input.Key.startsWith('results/')));
  assert.ok(puts.every((put) => !put.input.Body.includes('private_captain') && !put.input.Body.includes('918234756123')));
  assert.deepEqual(open(puts[0].input.Body), next);
  const envelopes = puts.map((put) => JSON.parse(put.input.Body));
  assert.equal(new Set(envelopes.map((e) => e.nonce)).size, envelopes.length);
  for (const e of envelopes) { assert.equal(Buffer.from(e.nonce, 'base64').length, 12); assert.equal(Buffer.from(e.tag, 'base64').length, 16); }
});

test('timeout after encrypted commit recovers from a later authenticated revision using retained receipt', async () => {
  const s3 = fakeS3(), store = createCaptainS3Store({ env, s3 });
  const previous = await store.read();
  s3.errorAfterPut = new Error('transport timeout'); s3.afterPut = () => s3.seed(seal(revision(2, [id1, id2])));
  assert.equal((await store.compareAndSet(previous, revision(1, [id1]), id1)).value.revision, 2);
});

test('message readback recognizes a concurrent official purge without retaining its deleted audit receipt', async () => {
  const s3 = fakeS3(), store = createCaptainS3Store({ env, s3 }), previous = await store.read();
  const sent = revision(1, []);
  sent.matches.ab = { scheduleVersion: 0, proposal: null, agreed: null, resultClaims: [], chatClosed: false,
    chat: { epoch: id1, participants: ['a', 'b'], generations: [null, null],
      messages: [{ id: id1, teamId: 'a', text: 'Remove this', createdAt: '2026-10-08T10:00:00Z' }] } };
  sent.requests[id1] = { action: 'message', matchId: 'ab', fingerprint: id2 };
  sent.history.push({ ...event(id1), kind: 'message', matchId: 'ab' });
  const closed = revision(2, []);
  closed.matches.ab = { scheduleVersion: 0, proposal: null, agreed: null, resultClaims: [], chatClosed: true, chat: null };
  closed.history.push({ id: id2, kind: 'matches_closed', at: '2026-10-08T10:00:01Z', matchIds: ['ab'] });
  s3.afterPut = () => s3.seed(seal(closed)); s3.errorAfterPut = new Error('response lost after commit');
  assert.deepEqual((await store.compareAndSet(previous, sent, id1)).value, closed);
});

test('unknown commit, absent ETag/bucket, plaintext legacy and invalid state fail closed', async () => {
  const s3 = fakeS3(), store = createCaptainS3Store({ env, s3 });
  const previous = await store.read();
  s3.errorAfterPut = new Error('timeout'); s3.afterPut = () => s3.seed(seal(revision(2, [id2])));
  await rejectCode(store.compareAndSet(previous, revision(1, [id1]), id1), 'storage_unavailable');
  s3.errorAfterPut = null; s3.afterPut = null; s3.omitEtag = true;
  await rejectCode(store.read(), 'storage_unavailable');
  s3.omitEtag = false;
  for (const body of ['{corrupt', JSON.stringify(emptyCaptainState()), seal({ ...emptyCaptainState(), schemaVersion: 1 }), seal({ ...emptyCaptainState(), schemaVersion: 2 }),
    seal({ ...emptyCaptainState(), matches: { ab: { messages: [], scheduleVersion: 0, proposal: null, agreed: null, resultClaims: [] } } })]) {
    s3.seed(body); await rejectCode(store.read(), 'storage_unavailable');
  }
  s3.getError = Object.assign(new Error(), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
  await rejectCode(store.read(), 'storage_unavailable');
});

test('ciphertext/tag/nonce/context tampering and wrong key never yield plaintext or reset state', async () => {
  const s3 = fakeS3(), store = createCaptainS3Store({ env, s3 });
  for (const field of ['ciphertext', 'tag', 'nonce']) {
    const envelope = JSON.parse(seal(revision(1, [id1]))), bytes = Buffer.from(envelope[field], 'base64');
    bytes[0] ^= 1; envelope[field] = bytes.toString('base64'); s3.seed(JSON.stringify(envelope));
    await rejectCode(store.read(), 'storage_unavailable');
  }
  for (const context of [aad('other-bucket'), aad(CAPTAIN_BUCKET, 'captains/other.json'), aad(CAPTAIN_BUCKET, CAPTAIN_STATE_KEY, 'another-tournament'), aad(CAPTAIN_BUCKET, CAPTAIN_STATE_KEY, 'dota2-autumn-2026', 2)]) {
    s3.seed(seal(revision(1, [id1]), context)); await rejectCode(store.read(), 'storage_unavailable');
  }
  s3.seed(seal(revision(1, [id1])));
  await rejectCode(createCaptainS3Store({ env: { YCS_CAPTAIN_ENCRYPTION_KEY: '7b'.repeat(32) }, s3 }).read(), 'storage_unavailable');
});

test('key is mandatory before any S3 access; clear and encoded capacities are bounded without truncation', async () => {
  let calls = 0;
  for (const config of [{}, { YCS_CAPTAIN_ENCRYPTION_KEY: 'invalid' }, { YCS_CAPTAIN_ENCRYPTION_KEY: 'aa'.repeat(31) }]) {
    const store = createCaptainS3Store({ env: config, s3: { send() { calls++; } } });
    await rejectCode(store.read(), 'captain_not_configured');
    await rejectCode(store.compareAndSet({ etag: null }, revision(1, [id1]), id1), 'captain_not_configured');
  }
  assert.equal(calls, 0);
  const s3 = fakeS3(), store = createCaptainS3Store({ env, s3 });
  const previous = await store.read(), large = revision(1, []);
  large.history = Array(60_000).fill(event(id1));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > CAPTAIN_MAX_BYTES);
  await rejectCode(store.compareAndSet(previous, large, id1), 'capacity_reached');
  assert.equal(s3.calls.filter((c) => c.constructor.name === 'PutObjectCommand').length, 0);
  s3.seed('x'.repeat(CAPTAIN_ENVELOPE_MAX_BYTES + 1));
  await rejectCode(store.read(), 'capacity_reached');
  assert.throws(() => validateCaptainState({ ...emptyCaptainState(), history: [{ ...event(id1), kind: 'message' }] }), (e) => e.code === 'storage_unavailable');
});
