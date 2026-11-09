// src/ai/inflight.js
const pending = new Map();

export function dedupe(key, factory) {
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => factory())().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export function inflightCount() {
  return pending.size;
}
