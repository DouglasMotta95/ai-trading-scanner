(() => {
  if (globalThis.__ATS_RUNTIME_MESSAGE_COMPAT__) return;
  globalThis.__ATS_RUNTIME_MESSAGE_COMPAT__ = true;

  const runtime = globalThis.chrome?.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') return;

  const nativeSendMessage = runtime.sendMessage.bind(runtime);

  runtime.sendMessage = (...input) => {
    const args = [...input];
    const userCallback = typeof args.at(-1) === 'function' ? args.pop() : null;

    return new Promise(resolve => {
      let settled = false;
      const finish = response => {
        if (settled) return;
        settled = true;
        try { void runtime.lastError; } catch {}
        try { userCallback?.(response); } catch {}
        resolve(response ?? null);
      };

      try {
        nativeSendMessage(...args, finish);
      } catch {
        finish(null);
      }
    });
  };
})();
