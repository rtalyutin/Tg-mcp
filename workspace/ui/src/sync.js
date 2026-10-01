// One workspace read at a time; mutations can request a fresh read after it.
export function createWorkspaceSync({
  read,
  onData,
  onError,
  onBusy,
  isActive,
  schedule = setTimeout,
  cancel = clearTimeout,
  interval = 15000,
  waitForInitial = false,
}) {
  let stopped = false,
    timer,
    pending,
    queued,
    failures = 0,
    reads = 0,
    waiting = waitForInitial;
  const clear = () => {
    cancel(timer);
    timer = undefined;
  };
  const plan = () => {
    clear();
    if (!stopped && !waiting && isActive())
      timer = schedule(
        () => refresh(),
        Math.min(interval * 2 ** failures, 120000),
      );
  };
  const refresh = ({ afterCurrent = false } = {}) => {
    if (stopped) return Promise.resolve();
    waiting = false;
    clear();
    if (pending) {
      if (!afterCurrent) return pending;
      // A pre-mutation snapshot must not satisfy a post-mutation refresh.
      queued ??= pending.then(() => {
        queued = undefined;
        return refresh();
      });
      return queued;
    }
    onBusy(true);
    pending = Promise.resolve()
      .then(read)
      .then((value) => {
        if (stopped) return;
        reads++;
        failures = 0;
        onData(value);
      })
      .catch((error) => {
        if (stopped) return;
        failures++;
        onError(error);
      })
      .finally(() => {
        pending = undefined;
        if (!stopped) {
          onBusy(false);
          plan();
        }
      });
    return pending;
  };
  return {
    refresh,
    receive(value) {
      // Ignore a late opener result once a newer explicit read has succeeded.
      if (stopped || reads) return;
      waiting = false;
      failures = 0;
      onData(value);
      if (!pending) plan();
    },
    failInitial(error) {
      if (stopped || reads) return;
      waiting = false;
      failures++;
      onError(error);
      if (!pending) plan();
    },
    start: plan,
    activityChanged() {
      if (!waiting && isActive()) return refresh();
      clear();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
