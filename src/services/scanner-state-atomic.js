const REVISION = Symbol('atsScannerStateRevision');
const DELETE = Symbol('atsScannerStateDelete');
const MAX_SNAPSHOTS = 80;

const originalGet = chrome.storage.local.get.bind(chrome.storage.local);
const originalSet = chrome.storage.local.set.bind(chrome.storage.local);

let writeQueue = Promise.resolve();
let revision = 0;
const snapshots = new Map();

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key === REVISION) continue;
    out[key] = clone(value[key]);
  }
  return out;
};

const equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => equal(value, b[index]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
};

const diff = (base, next) => {
  if (equal(base, next)) return undefined;
  if (!isObject(base) || !isObject(next)) return clone(next);

  const patch = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      patch[key] = DELETE;
      continue;
    }
    const child = diff(base?.[key], next[key]);
    if (child !== undefined) patch[key] = child;
  }
  return Object.keys(patch).length ? patch : undefined;
};

const applyPatch = (current, patch) => {
  if (!isObject(patch)) return clone(patch);
  const next = isObject(current) ? clone(current) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === DELETE) {
      delete next[key];
      continue;
    }
    next[key] = isObject(value) && isObject(current?.[key])
      ? applyPatch(current[key], value)
      : clone(value);
  }
  return next;
};

const remember = state => {
  const snapshot = clone(state || {});
  snapshots.set(revision, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
  return snapshot;
};

const tag = state => {
  if (!isObject(state)) return state;
  const tagged = clone(state);
  Object.defineProperty(tagged, REVISION, {
    value: revision,
    enumerable: true,
    configurable: true
  });
  remember(tagged);
  return tagged;
};

chrome.storage.local.get = async (...args) => {
  await writeQueue.catch(() => {});
  const result = await originalGet(...args);
  if (result && Object.prototype.hasOwnProperty.call(result, 'scannerState')) {
    result.scannerState = tag(result.scannerState || {});
  }
  return result;
};

chrome.storage.local.set = async items => {
  if (!items || !Object.prototype.hasOwnProperty.call(items, 'scannerState')) {
    return originalSet(items);
  }

  const task = writeQueue.then(async () => {
    const proposed = items.scannerState || {};
    const baseRevision = proposed?.[REVISION];
    const cleanProposed = clone(proposed);
    const stored = await originalGet('scannerState');
    const current = clone(stored?.scannerState || {});

    let next;
    if (Number.isInteger(baseRevision) && snapshots.has(baseRevision)) {
      const base = snapshots.get(baseRevision);
      let patch = diff(base, cleanProposed) || {};

      const pairTouched = Object.prototype.hasOwnProperty.call(patch, 'candles')
        || Object.prototype.hasOwnProperty.call(patch, 'signal');
      if (pairTouched) {
        patch = {
          ...patch,
          candles: clone(cleanProposed.candles ?? []),
          signal: clone(cleanProposed.signal ?? null)
        };
      }

      next = applyPatch(current, patch);
    } else {
      next = cleanProposed;
    }

    revision += 1;
    remember(next);

    const rest = { ...items };
    delete rest.scannerState;
    await originalSet({ ...rest, scannerState: next });
  });

  writeQueue = task.catch(() => {});
  return task;
};

export const flushScannerStateWrites = () => writeQueue;
