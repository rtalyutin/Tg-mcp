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
  initialWait = 3000,
  retryInterval = 5000,
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
    if (!stopped && isActive())
      timer = schedule(
        () => refresh(),
        waiting
          ? initialWait
          : failures
            ? Math.min(retryInterval * 2 ** (failures - 1), 120000)
            : interval,
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
      if (isActive()) return waiting ? plan() : refresh();
      clear();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
