import test from "node:test";
import assert from "node:assert/strict";
import { createDetailLoader } from "../src/detail-loader.js";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function harness() {
  const calls = [], data = [], errors = [];
  const loader = createDetailLoader({
    read: (operation, args) => new Promise((resolve, reject) => {
      calls.push({ operation, args, resolve, reject });
    }),
    onData: (target, value) => data.push({ target, value }),
    onError: (target, error) => errors.push({ target, error }),
  });
  return { loader, calls, data, errors };
}
const request = (target) => ({ target, operation: "project_get", id: target.id });

test("a 20-second detail read remains visible despite 15-second workspace updates", async () => {
  const { loader, calls, data } = harness();
  const target = { id: "rock-group" };
  const first = loader.load(request(target));
  await flush();
  // Virtual time: the workspace snapshot arrives at 15s; read finishes at 20s.
  const queued = loader.load(request(target), { afterCurrent: true });
  assert.equal(calls.length, 1);
  calls[0].resolve("first state at 20s");
  await first;
  await flush();
  assert.deepEqual(data, [{ target, value: "first state at 20s" }]);
  assert.equal(calls.length, 2);
  // Another snapshot at 30s waits for the second read, rather than overlapping.
  const latest = loader.load(request(target), { afterCurrent: true });
  assert.equal(calls.length, 2);
  calls[1].resolve("second state at 40s");
  await queued;
  await flush();
  assert.equal(data.at(-1).value, "second state at 40s");
  calls[2].resolve("latest state");
  await latest;
});

test("post-mutation reload waits for one fresh follow-up and repeated requests coalesce", async () => {
  const { loader, calls, data } = harness();
  const target = { id: "task" };
  const first = loader.load(request(target));
  await flush();
  const fresh = loader.load(request(target), { afterCurrent: true });
  assert.equal(loader.load(request(target), { afterCurrent: true }), fresh);
  calls[0].resolve("before mutation");
  await first;
  await flush();
  assert.equal(calls.length, 2);
  calls[1].resolve("after mutation");
  assert.equal(await fresh, "after mutation");
  assert.deepEqual(data.map((entry) => entry.value), ["before mutation", "after mutation"]);
});

test("switching targets ignores stale responses and reuses an unfinished same-id read", async () => {
  const { loader, calls, data } = harness();
  const a = { id: "a" }, b = { id: "b" };
  const first = loader.load(request(a));
  const second = loader.load(request(b));
  await flush();
  calls[0].resolve("stale A");
  await first;
  assert.deepEqual(data, []);
  const bAgain = { id: "b" };
  assert.equal(loader.load(request(bAgain)), second);
  assert.equal(calls.length, 2);
  calls[1].resolve("B");
  await second;
  assert.deepEqual(data, [{ target: bAgain, value: "B" }]);
});

test("failed reads report the current error and a queued refresh can recover", async () => {
  const { loader, calls, data, errors } = harness();
  const target = { id: "a" };
  const first = loader.load(request(target));
  await flush();
  const fresh = loader.load(request(target), { afterCurrent: true });
  const failed = assert.rejects(first, /timeout/);
  calls[0].reject(new Error("timeout"));
  await failed;
  await flush();
  assert.equal(errors.length, 1);
  calls[1].resolve("recovered");
  assert.equal(await fresh, "recovered");
  assert.equal(data.at(-1).value, "recovered");
});

test("connection reset suppresses old responses and queued reads", async () => {
  const { loader, calls, data } = harness();
  const target = { id: "a" };
  const first = loader.load(request(target));
  await flush();
  const queued = loader.load(request(target), { afterCurrent: true });
  loader.reset();
  const current = loader.load(request(target));
  await flush();
  calls[0].resolve("old connection");
  await first;
  assert.equal(await queued, undefined);
  assert.deepEqual(data, []);
  assert.equal(calls.length, 2);
  calls[1].resolve("new connection");
  await current;
  assert.equal(data.at(-1).value, "new connection");
});
