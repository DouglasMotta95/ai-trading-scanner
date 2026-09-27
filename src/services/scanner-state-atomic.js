import { storageLocalGet, storageLocalSet } from './chrome-compat.js';

let scannerStateWriteQueue = Promise.resolve();

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = clone(child);
  return out;
};

async function storedScannerState() {
  const stored = await storageLocalGet('scannerState');
  return clone(stored?.scannerState || {});
}

export async function readScannerState() {
  await scannerStateWriteQueue.catch(() => {});
  return storedScannerState();
}

export function updateScannerState(mutator) {
  if (typeof mutator !== 'function') throw new TypeError('updateScannerState requires a mutator function');

  const task = scannerStateWriteQueue.then(async () => {
    const current = await storedScannerState();
    const proposed = await mutator(clone(current));
    if (proposed === undefined) return current;

    const next = clone(proposed || {});
    await storageLocalSet({ scannerState: next });
    return clone(next);
  });

  scannerStateWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

export const replaceScannerState = next => updateScannerState(() => clone(next || {}));
export const flushScannerStateWrites = () => scannerStateWriteQueue;
