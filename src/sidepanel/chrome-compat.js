(() => {
  if (globalThis.__ATS_UI_CHROME_COMPAT__) return;
  globalThis.__ATS_UI_CHROME_COMPAT__ = true;

  const wrapPromiseApi = (target, method, fallback) => {
    const original = target?.[method];
    if (typeof original !== 'function') return false;
    if (original.__ATS_COMPAT_WRAPPED__) return true;
    const nativeCall = original.bind(target);

    const wrapped = (...args) => {
      if (typeof args.at(-1) === 'function') return nativeCall(...args);
      return new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          resolve(value === undefined ? fallback : value);
        };
        const callback = value => {
          try {
            if (chrome.runtime?.lastError) {
              finish(fallback);
              return;
            }
          } catch {}
          finish(value);
        };
        try {
          const returned = nativeCall(...args, callback);
          if (returned && typeof returned.then === 'function') {
            returned.then(finish).catch(() => finish(fallback));
          }
        } catch {
          finish(fallback);
        }
      });
    };

    try { Object.defineProperty(wrapped, '__ATS_COMPAT_WRAPPED__', { value: true }); } catch {}
    try {
      target[method] = wrapped;
      if (target[method] === wrapped) return true;
    } catch {}
    try {
      Object.defineProperty(target, method, { configurable: true, writable: true, value: wrapped });
      return target[method] === wrapped;
    } catch {
      return false;
    }
  };

  const status = {
    runtime: wrapPromiseApi(globalThis.chrome?.runtime, 'sendMessage', null),
    storageGet: wrapPromiseApi(globalThis.chrome?.storage?.local, 'get', {}),
    storageSet: wrapPromiseApi(globalThis.chrome?.storage?.local, 'set', null),
    tabs: wrapPromiseApi(globalThis.chrome?.tabs, 'sendMessage', null)
  };

  globalThis.__ATS_UI_CHROME_COMPAT_STATUS__ = status;
})();
