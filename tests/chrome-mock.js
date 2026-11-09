export function createChromeMock() {
  const store = new Map();
  const listeners = [];
  const installedListeners = [];
  const startupListeners = [];

  const local = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    async clear() {
      store.clear();
    },
    __reset() {
      store.clear();
    },
    __dump() {
      return Object.fromEntries(store);
    }
  };

  return {
    storage: { local },
    runtime: {
      id: "test-extension-id",
      lastError: null,
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        __listeners: listeners
      },
      onInstalled: {
        addListener: (fn) => installedListeners.push(fn),
        __listeners: installedListeners
      },
      onStartup: {
        addListener: (fn) => startupListeners.push(fn),
        __listeners: startupListeners
      },
      __clearListeners() {
        listeners.length = 0;
        installedListeners.length = 0;
        startupListeners.length = 0;
      },
      async sendMessage(msg) {
        for (const fn of listeners) {
          let sync = false;
          let syncValue;
          let resolveDone;
          const done = new Promise((resolve) => {
            resolveDone = resolve;
          });
          let returning = true;
          const response = (v) => {
            if (returning) {
              sync = true;
              syncValue = v;
            }
            resolveDone(v);
          };
          const returned = fn(msg, { id: "test" }, response);
          returning = false;
          if (sync) return syncValue;
          if (returned === true) return await done;
        }
        return undefined;
      }
    },
    tabs: {
      async query() {
        return [{ id: 1, url: "https://example.com/job/1" }];
      },
      async sendMessage() {
        return { ok: true };
      }
    }
  };
}
