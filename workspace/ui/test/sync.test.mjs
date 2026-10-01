import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceSync } from "../src/sync.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
function harness(read) {
  const state = {
    active: true,
    data: [],
    errors: [],
    busy: [],
    timers: new Map(),
  };
  let id = 0;
  const sync = createWorkspaceSync({
    read,
    onData: (value) => state.data.push(value),
    onError: (error) => state.errors.push(error),
    onBusy: (busy) => state.busy.push(busy),
    isActive: () => state.active,
    schedule: (fn, delay) => {
      state.timers.set(++id, { fn, delay });
      return id;
    },
    cancel: (key) => state.timers.delete(key),
  });
  const tick = async () => {
    const [key, timer] = state.timers.entries().next().value;
    state.timers.delete(key);
    await timer.fn();
  };
  const delay = () => [...state.timers.values()][0]?.delay;
  return { sync, state, tick, delay };
}
test("external updates poll in foreground, pause inactive, refresh on return", async () => {
  let snapshot = "initial";
  const { sync, state, tick, delay } = harness(async () => snapshot);
  sync.receive(snapshot);
  assert.equal(delay(), 15000);
  snapshot = "changed by chat/worker";
  await tick();
  assert.deepEqual(state.data, ["initial", snapshot]);
  state.active = false;
  sync.activityChanged();
  assert.equal(state.timers.size, 0);
  state.active = true;
  snapshot = "changed while hidden";
  await sync.activityChanged();
  assert.equal(state.data.at(-1), snapshot);
  sync.stop();
  assert.equal(state.timers.size, 0);
});
test("failures preserve last good snapshot and back off, then recover", async () => {
  let failure = true;
  const { sync, state, tick, delay } = harness(async () => {
    if (failure) throw new Error("offline");
    return "fresh";
  });
  sync.receive("last good timestamp");
  for (const expected of [30000, 60000, 120000, 120000]) {
    await tick();
    assert.equal(delay(), expected);
    assert.deepEqual(state.data, ["last good timestamp"]);
  }
  failure = false;
  await tick();
  assert.equal(state.data.at(-1), "fresh");
  assert.equal(delay(), 15000);
});
test("coalesce reads but require a newer snapshot after a mutation", async () => {
  const first = deferred(),
    second = deferred();
  let count = 0;
  const { sync, state } = harness(() =>
    ++count === 1 ? first.promise : second.promise,
  );
  const pending = sync.refresh();
  assert.equal(sync.refresh(), pending);
  const mutationRefresh = sync.refresh({ afterCurrent: true });
  assert.equal(sync.refresh({ afterCurrent: true }), mutationRefresh);
  await Promise.resolve();
  assert.equal(count, 1);
  first.resolve("snapshot before create");
  await pending;
  await Promise.resolve();
  assert.equal(count, 2);
  second.resolve("snapshot includes created project");
  await mutationRefresh;
  assert.deepEqual(state.data, [
    "snapshot before create",
    "snapshot includes created project",
  ]);
  assert.equal(state.busy.at(-1), false);
});
test("late host opener and reads completing after disposal cannot overwrite data", async () => {
  const request = deferred();
  const { sync, state } = harness(() => request.promise);
  const pending = sync.refresh();
  request.resolve("newer snapshot");
  await pending;
  sync.receive("late initial tool result");
  assert.deepEqual(state.data, ["newer snapshot"]);
  sync.stop();
  await sync.refresh();
  const other = deferred();
  const disposed = harness(() => other.promise);
  const stillReading = disposed.sync.refresh();
  disposed.sync.stop();
  other.resolve("unmounted");
  await stillReading;
  assert.deepEqual(disposed.state.data, []);
  assert.equal(disposed.state.timers.size, 0);
});
