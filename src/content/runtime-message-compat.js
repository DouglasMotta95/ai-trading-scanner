(() => {
  if (globalThis.__ATS_RUNTIME_MESSAGE_COMPAT__) return;
  globalThis.__ATS_RUNTIME_MESSAGE_COMPAT__ = true;

  const runtime = globalThis.chrome?.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') return;

  // Android extension browsers such as Quetta may expose callback-only
  // chrome.runtime.sendMessage. Keep one explicit bridge instead of assuming
  // the native call returns a Promise.
  globalThis.__ATS_SEND_MESSAGE__ = message => new Promise(resolve => {
    let settled = false;
    const finish = response => {
      if (settled) return;
      settled = true;
      try { void runtime.lastError; } catch {}
      resolve(response ?? null);
    };

    try {
      const returned = runtime.sendMessage(message, finish);
      if (returned && typeof returned.then === 'function') {
        returned.then(finish).catch(() => finish(null));
      }
    } catch {
      finish(null);
    }
  });
})();
