const memorySession = new Map();

function runtimeError() {
  try {
    const message = chrome?.runtime?.lastError?.message;
    return message ? new Error(message) : null;
  } catch {
    return null;
  }
}

function invoke(target, method, args = [], { optional = false } = {}) {
  return new Promise((resolve, reject) => {
    const fn = target?.[method];
    if (typeof fn !== 'function') {
      if (optional) return resolve(undefined);
      return reject(new Error(`chrome_api_unavailable:${method}`));
    }

    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const callback = (...values) => {
      const error = runtimeError();
      done(error, values.length <= 1 ? values[0] : values);
    };

    try {
      const returned = fn.call(target, ...args, callback);
      if (returned && typeof returned.then === 'function') {
        returned.then(value => done(null, value), error => done(error));
      }
    } catch (error) {
      done(error);
    }
  });
}

export const storageLocalGet = keys => invoke(chrome?.storage?.local, 'get', [keys]);
export const storageLocalSet = items => invoke(chrome?.storage?.local, 'set', [items]);
export const storageLocalRemove = keys => invoke(chrome?.storage?.local, 'remove', [keys]);

function memoryGet(keys) {
  if (keys == null) return Object.fromEntries(memorySession.entries());
  if (typeof keys === 'string') return { [keys]: memorySession.get(keys) };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, memorySession.get(key)]));
  if (typeof keys === 'object') {
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, memorySession.has(key) ? memorySession.get(key) : fallback]));
  }
  return {};
}

export async function storageSessionGet(keys) {
  if (chrome?.storage?.session?.get) return invoke(chrome.storage.session, 'get', [keys]);
  return memoryGet(keys);
}

export async function storageSessionSet(items = {}) {
  if (chrome?.storage?.session?.set) return invoke(chrome.storage.session, 'set', [items]);
  for (const [key, value] of Object.entries(items || {})) memorySession.set(key, value);
}

export async function storageSessionRemove(keys) {
  if (chrome?.storage?.session?.remove) return invoke(chrome.storage.session, 'remove', [keys]);
  for (const key of Array.isArray(keys) ? keys : [keys]) memorySession.delete(key);
}

export const runtimeSendMessage = message => invoke(chrome?.runtime, 'sendMessage', [message]);
export const tabsQuery = query => invoke(chrome?.tabs, 'query', [query]);
export const tabsUpdate = (tabId, update) => invoke(chrome?.tabs, 'update', [tabId, update]);
export const tabsSendMessage = (tabId, message) => invoke(chrome?.tabs, 'sendMessage', [tabId, message]);
export const tabsCreate = createProperties => invoke(chrome?.tabs, 'create', [createProperties]);
export const scriptingExecuteScript = details => invoke(chrome?.scripting, 'executeScript', [details]);
export const permissionsContains = permissions => invoke(chrome?.permissions, 'contains', [permissions], { optional: true });
export const permissionsRequest = permissions => invoke(chrome?.permissions, 'request', [permissions], { optional: true });
export const sidePanelSetBehavior = options => invoke(chrome?.sidePanel, 'setPanelBehavior', [options], { optional: true });
export const windowsCreate = createProperties => invoke(chrome?.windows, 'create', [createProperties]);
export const windowsGet = windowId => invoke(chrome?.windows, 'get', [windowId], { optional: true });
export const windowsUpdate = (windowId, updateInfo) => invoke(chrome?.windows, 'update', [windowId, updateInfo], { optional: true });
export const windowsRemove = windowId => invoke(chrome?.windows, 'remove', [windowId], { optional: true });
export const windowsApiAvailable = () => !!chrome?.windows?.create;
