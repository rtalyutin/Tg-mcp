// Keep a slow detail read useful while workspace snapshots continue to arrive.
export function createDetailLoader({ read, onData, onError }) {
  const flights = new Map();
  let current = null,
    generation = 0;
  const keyOf = ({ operation, id }) => `${operation}:${id}`;
  const visible = (key, flight) =>
    current && keyOf(current) === key && flights.get(key) === flight;
  const start = (request, key) => {
    const flight = { queued: null, generation };
    flight.pending = Promise.resolve()
      .then(() => read(request.operation, { id: request.id }))
      .then(
        (value) => {
          if (visible(key, flight)) onData(current.target, value);
          return value;
        },
        (error) => {
          if (visible(key, flight)) onError(current.target, error);
          throw error;
        },
      )
      .finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
      });
    flights.set(key, flight);
    return flight.pending;
  };
  return {
    load(request, { afterCurrent = false } = {}) {
      current = request;
      const key = keyOf(request);
      const flight = flights.get(key);
      if (!flight) return start(request, key);
      if (!afterCurrent) return flight.pending;
      // A mutation or newer workspace snapshot gets one read after this one.
      const followUp = () =>
        current && keyOf(current) === key && flight.generation === generation
          ? (flights.get(key)?.pending ?? start(current, key))
          : undefined;
      flight.queued ??= flight.pending.then(followUp, followUp);
      return flight.queued;
    },
    clear() {
      current = null;
    },
    reset() {
      current = null;
      generation++;
      flights.clear();
    },
  };
}
