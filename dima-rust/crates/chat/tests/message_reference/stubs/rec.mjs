// The recording shared by the stubs and record.mts (one per process, on globalThis).
export const R = (globalThis.__messageRecorder ??= {
  calls: [],
  pending: new Set(),
  config: {},
  metrics: { started: 0, ended: 0, failed: 0 },
});

/** Records a call of `kind`. */
export function record(kind, data) {
  R.calls.push({ kind, ...data });
}

/** Keeps `promise` in the pending set until it settles (the handler's fire-and-forget calls). */
export function track(promise) {
  R.pending.add(promise);
  const done = () => R.pending.delete(promise);
  promise.then(done, done);
  return promise;
}

/** A JSON copy (what was passed, as data). */
export const copy = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
