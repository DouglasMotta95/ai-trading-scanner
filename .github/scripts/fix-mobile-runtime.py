from pathlib import Path


def replace_all(path, replacements, prepend=None):
    p = Path(path)
    s = p.read_text()
    if prepend and prepend not in s:
        s = prepend + s
    for old, new in replacements:
        if old not in s:
            raise AssertionError(f'{path}: missing expected fragment: {old[:120]!r}')
        s = s.replace(old, new)
    p.write_text(s)

# Storage/services: always use callback-compatible wrappers.
replace_all('src/services/telemetry.js', [
    ('chrome.storage.local.get(', 'storageLocalGet('),
    ('chrome.storage.local.set(', 'storageLocalSet('),
    ('chrome.storage.local.remove(', 'storageLocalRemove('),
], "import { storageLocalGet, storageLocalSet, storageLocalRemove } from './chrome-compat.js';\n\n")

replace_all('src/services/license.js', [
    ('chrome.storage.local.get(', 'storageLocalGet('),
    ('chrome.storage.local.set(', 'storageLocalSet('),
    ('chrome.storage.local.remove(', 'storageLocalRemove('),
], "import { storageLocalGet, storageLocalSet, storageLocalRemove } from './chrome-compat.js';\n")

# Background runtime APIs used by the scanner lifecycle.
background = Path('src/background.js')
s = background.read_text()
compat_import = "import { storageLocalGet, storageLocalSet, storageLocalRemove, storageSessionGet, storageSessionSet, storageSessionRemove, tabsQuery, tabsUpdate, tabsSendMessage, scriptingExecuteScript, sidePanelSetBehavior } from './services/chrome-compat.js';\n"
needle = "import { readScannerState, updateScannerState, replaceScannerState } from './services/scanner-state-atomic.js';\n"
if compat_import not in s:
    assert needle in s
    s = s.replace(needle, needle + compat_import, 1)
for old, new in [
    ('chrome.storage.local.get(', 'storageLocalGet('),
    ('chrome.storage.local.set(', 'storageLocalSet('),
    ('chrome.storage.local.remove(', 'storageLocalRemove('),
    ('chrome.storage.session.get(', 'storageSessionGet('),
    ('chrome.storage.session.set(', 'storageSessionSet('),
    ('chrome.storage.session.remove(', 'storageSessionRemove('),
    ('chrome.tabs.query(', 'tabsQuery('),
    ('chrome.tabs.update(', 'tabsUpdate('),
    ('chrome.tabs.sendMessage(', 'tabsSendMessage('),
    ('chrome.scripting.executeScript(', 'scriptingExecuteScript('),
    ('chrome.sidePanel.setPanelBehavior(', 'sidePanelSetBehavior('),
]:
    s = s.replace(old, new)
s = s.replace("{ file: 'src/content/focused-asset.js', world: 'ISOLATED', allFrames: false }", "{ file: 'src/content/focused-asset.js', world: 'ISOLATED', allFrames: true }")
background.write_text(s)

# Background augment: callback-compatible settings read + accept trusted embedded visual frames.
augment = Path('src/background-augment.js')
s = augment.read_text()
imp = "import { storageLocalGet } from './services/chrome-compat.js';\n"
if imp not in s:
    marker = "import { updateScannerState } from './services/scanner-state-atomic.js';\n"
    assert marker in s
    s = s.replace(marker, marker + imp, 1)
s = s.replace("chrome.storage.local.get('settings')", "storageLocalGet('settings')")
old = """async function setFocusedAsset(message = {}, sender = {}) {
  const focused = normAsset(message.asset);
  if (!focused || !sender?.tab?.id || sender.frameId !== 0) return;

  let senderHost = '';
  try { senderHost = new URL(sender.url || sender.tab.url || '').hostname; } catch {}
  if (!isCasaTradeHost(senderHost)) return;

  const tabId = sender.tab.id;
"""
new = """async function setFocusedAsset(message = {}, sender = {}) {
  const focused = normAsset(message.asset);
  if (!focused || !sender?.tab?.id) return;

  let senderHost = '';
  let topHost = '';
  try { senderHost = new URL(sender.url || '').hostname; } catch {}
  try { topHost = new URL(sender.tab.url || '').hostname; } catch {}
  const topLevelCasaTrade = sender.frameId === 0 && isCasaTradeHost(senderHost || topHost);
  const trustedEmbeddedVisual = sender.frameId !== 0 && trustedEmbeddedHost(senderHost) && isCasaTradeHost(topHost);
  if (!topLevelCasaTrade && !trustedEmbeddedVisual) return;

  const tabId = sender.tab.id;
"""
assert old in s
s = s.replace(old, new, 1)
old = """  const source = clean(message.source || 'chart-header');
  const visual = message.visual === true || source === 'chart-header' || source === 'user-selection';
  const reliable = message.reliable === true || source === 'user-selection' || score >= FOCUS_CHANGE_MIN_SCORE || samples >= 2;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused) && !reliable) return;

  focusedAssets.set(tabId, { asset: focused, score, samples, reliable, visual, source, at: Date.now() });
"""
new = """  const source = clean(message.source || 'chart-header');
  const explicit = message.explicit === true || source === 'user-selection';
  const visual = message.visual === true || source === 'chart-header' || source === 'user-selection' || source === 'single-frame-asset';
  const reliable = message.reliable === true || explicit || source === 'single-frame-asset' || score >= FOCUS_CHANGE_MIN_SCORE || samples >= 2;
  const previousProtected = previousFocus?.source === 'user-selection' || previousFocus?.explicit === true;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused) && (!reliable || (previousProtected && !explicit))) return;

  focusedAssets.set(tabId, { asset: focused, score, samples, reliable, visual, source, explicit, frameId: sender.frameId, at: Date.now() });
"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace("score, samples, reliable, visual, source\n", "score, samples, reliable, visual, source, explicit, frameId: sender.frameId\n")
augment.write_text(s)

# Sidepanel classic script compatibility.
app = Path('src/sidepanel/app.js')
s = app.read_text()
helper = """function uiChromeCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    const fn = target?.[method];
    if (typeof fn !== 'function') return reject(new Error(`chrome_api_unavailable:${method}`));
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const callback = value => {
      let error = null;
      try { error = chrome.runtime?.lastError?.message ? new Error(chrome.runtime.lastError.message) : null; } catch {}
      done(error, value);
    };
    try {
      const returned = fn.call(target, ...args, callback);
      if (returned && typeof returned.then === 'function') returned.then(value => done(null, value), error => done(error));
    } catch (error) { done(error); }
  });
}
const uiStorageGet = keys => uiChromeCall(chrome.storage?.local, 'get', keys);
const uiStorageSet = items => uiChromeCall(chrome.storage?.local, 'set', items);
const uiSendMessage = message => uiChromeCall(chrome.runtime, 'sendMessage', message);

"""
if not s.startswith('function uiChromeCall'):
    s = helper + s
s = s.replace('chrome.storage.local.get(', 'uiStorageGet(')
s = s.replace('chrome.storage.local.set(', 'uiStorageSet(')
s = s.replace('chrome.runtime.sendMessage(', 'uiSendMessage(')
# Make acquisition states truthful instead of showing ANALYZING before any market data exists.
old = """  if (!active) return { key: 'BLOCKED', text: 'ATIVAÇÃO NECESSÁRIA', detail: 'Ative a licença para iniciar a análise.' };
  if (!online || step.stage !== 'diagnosing_next_candle') {
    return { key: 'ANALYZING_MARKET', text: 'ANALISANDO MERCADO ATUAL', detail: step.reason };
  }
"""
new = """  if (!active) return { key: 'BLOCKED', text: 'ATIVAÇÃO NECESSÁRIA', detail: 'Ative a licença para iniciar a análise.' };
  if (!online || step.stage !== 'diagnosing_next_candle') {
    const acquisitionLabels = {
      connecting: 'CONECTANDO À CASATRADE',
      confirming_asset: 'IDENTIFICANDO ATIVO ABERTO',
      reading_price: 'LENDO COTAÇÃO DO ATIVO',
      reading_history: 'CARREGANDO HISTÓRICO DO GRÁFICO',
      analyzing_current: 'ANALISANDO MERCADO ATUAL'
    };
    return { key: 'ANALYZING_MARKET', text: acquisitionLabels[step.stage] || 'ANALISANDO MERCADO ATUAL', detail: step.reason };
  }
"""
assert old in s
s = s.replace(old, new, 1)
app.write_text(s)

# Account connector compatibility.
account = Path('src/sidepanel/account-login.js')
s = account.read_text()
imp = "import { storageLocalGet, storageLocalSet, storageLocalRemove, runtimeSendMessage, permissionsContains, permissionsRequest, tabsCreate } from '../services/chrome-compat.js';\n"
if imp not in s:
    marker = "import { installationId } from '../services/telemetry.js';\n"
    assert marker in s
    s = s.replace(marker, marker + imp, 1)
s = s.replace('chrome.storage.local.get(', 'storageLocalGet(')
s = s.replace('chrome.storage.local.set(', 'storageLocalSet(')
s = s.replace('chrome.storage.local.remove(', 'storageLocalRemove(')
s = s.replace('chrome.runtime.sendMessage(', 'runtimeSendMessage(')
s = s.replace('chrome.tabs.create(', 'tabsCreate(')
old = """      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      return chrome.permissions.request({ origins: [origin] });
"""
new = """      const contained = await permissionsContains({ origins: [origin] });
      if (contained === undefined || contained === true) return true;
      const requested = await permissionsRequest({ origins: [origin] });
      return requested !== false;
"""
assert old in s
s = s.replace(old, new, 1)
account.write_text(s)

# real-entry: callback-compatible runtime messaging.
real = Path('src/sidepanel/real-entry.js')
s = real.read_text()
helper = """function atsRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    try {
      const returned = chrome.runtime.sendMessage(message, value => {
        let error = null;
        try { error = chrome.runtime?.lastError?.message ? new Error(chrome.runtime.lastError.message) : null; } catch {}
        done(error, value);
      });
      if (returned && typeof returned.then === 'function') returned.then(value => done(null, value), error => done(error));
    } catch (error) { done(error); }
  });
}

"""
if not s.startswith('function atsRuntimeMessage'):
    s = helper + s
s = s.replace("chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' })", "atsRuntimeMessage({ type: 'ATS_READ_SCANNER_STATE' })")
real.write_text(s)

# Focus tracker: sticky manual selection, touch/shadow support, callback messaging.
focus = Path('src/content/focused-asset.js')
s = focus.read_text()
s = s.replace("  const USER_SELECTION_MS = 3500;\n", "")
old_query = """    let nodes = [];
    try {
      nodes = document.querySelectorAll('[aria-selected],[aria-current],[data-state],[data-active],[role=\"tab\"],button,span,strong,b,div,p');
    } catch {}

    for (const el of nodes) {
"""
new_query = """    const roots = [document];
    const seenRoots = new Set(roots);
    for (let i = 0; i < roots.length && i < 250; i++) {
      let descendants = [];
      try { descendants = roots[i].querySelectorAll('*'); } catch {}
      for (const node of descendants) {
        if (node.shadowRoot && !seenRoots.has(node.shadowRoot)) {
          seenRoots.add(node.shadowRoot);
          roots.push(node.shadowRoot);
        }
      }
    }
    const nodes = [];
    for (const root of roots) {
      try { nodes.push(...root.querySelectorAll('[aria-selected],[aria-current],[data-state],[data-active],[role=\"tab\"],button,span,strong,b,div,p')); } catch {}
    }

    for (const el of nodes) {
"""
assert old_query in s
s = s.replace(old_query, new_query, 1)
old_return = """    rows.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.top - b.top || a.left - b.left);
    return rows[0] || null;
"""
new_return = """    rows.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.top - b.top || a.left - b.left);
    const uniqueAssets = new Set(rows.map(row => assetIdentity(row.asset)).filter(Boolean));
    const winner = rows[0] || null;
    return winner ? { ...winner, singleAsset: uniqueAssets.size === 1 } : null;
"""
assert old_return in s
s = s.replace(old_return, new_return, 1)
old_choose = """  function chooseCandidate() {
    const scanned = focusedAssetCandidate();
    const now = Date.now();
    if (userSelection && now - userSelection.at <= USER_SELECTION_MS) {
      if (!scanned || sameAsset(scanned.asset, userSelection.asset) || !scanned.explicit) {
        return { asset: userSelection.asset, score: Math.max(900, Number(scanned?.score || 0)), explicit: true, source: 'user-selection' };
      }
    }
    return scanned;
  }
"""
new_choose = """  function chooseCandidate() {
    const scanned = focusedAssetCandidate();
    if (userSelection) {
      if (!scanned || sameAsset(scanned.asset, userSelection.asset) || !scanned.explicit) {
        return { asset: userSelection.asset, score: Math.max(900, Number(scanned?.score || 0)), explicit: true, source: 'user-selection' };
      }
      userSelection = null;
    }
    if (scanned?.singleAsset && !scanned.explicit) return { ...scanned, source: 'single-frame-asset' };
    return scanned;
  }
"""
assert old_choose in s
s = s.replace(old_choose, new_choose, 1)
s = s.replace("      explicit: selection.explicit, source: 'chart-header' });", "      explicit: selection.explicit, source: 'chart-header' });")
s = s.replace("      source: candidate.source || 'chart-header'\n", "      source: candidate.source || 'chart-header',\n      explicit: candidate.explicit === true\n")
old_send = """    chrome.runtime.sendMessage({
      type: 'ATS_FOCUSED_ASSET',
      asset: candidate.asset,
      score: Number(candidate.score || 0),
      samples: candidateSamples,
      stableFor,
      reliable,
      visual: true,
      source: candidate.source || 'chart-header',
      at: now
    }).catch(() => {});
"""
new_send = """    try {
      chrome.runtime.sendMessage({
        type: 'ATS_FOCUSED_ASSET',
        asset: candidate.asset,
        score: Number(candidate.score || 0),
        samples: candidateSamples,
        stableFor,
        reliable,
        visual: true,
        source: candidate.source || 'chart-header',
        explicit: candidate.explicit === true,
        at: now
      }, () => void chrome.runtime?.lastError);
    } catch {}
"""
assert old_send in s
s = s.replace(old_send, new_send, 1)
old_remember = """  function rememberUserSelection(event) {
    const target = event?.target instanceof Element ? event.target : null;
    if (!target) return;
    const actionLabel = clean(target.getAttribute?.('aria-label') || target.getAttribute?.('title') || '');
    if (/fechar|close|remover|remove|delete|excluir/i.test(actionLabel)) return;
    const hit = assetFromElement(target);
    if (!hit?.asset) return;
    userSelection = { asset: hit.asset, at: Date.now() };
    candidateAsset = hit.asset;
    candidateSince = Date.now();
    candidateSamples = Math.max(candidateSamples, 2);
    publish(true);
  }

  document.addEventListener('pointerup', rememberUserSelection, true);
  document.addEventListener('click', rememberUserSelection, true);
"""
new_remember = """  function rememberUserSelection(event) {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : [event?.target];
    for (const target of path) {
      if (!(target instanceof Element)) continue;
      const actionLabel = clean(target.getAttribute?.('aria-label') || target.getAttribute?.('title') || '');
      if (/fechar|close|remover|remove|delete|excluir/i.test(actionLabel)) return;
      const hit = assetFromElement(target);
      if (!hit?.asset) continue;
      userSelection = { asset: hit.asset, at: Date.now() };
      candidateAsset = hit.asset;
      candidateSince = Date.now();
      candidateSamples = Math.max(candidateSamples, 2);
      publish(true);
      return;
    }
  }

  document.addEventListener('pointerup', rememberUserSelection, true);
  document.addEventListener('touchend', rememberUserSelection, true);
  document.addEventListener('click', rememberUserSelection, true);
"""
assert old_remember in s
s = s.replace(old_remember, new_remember, 1)
focus.write_text(s)

# Manifest: run focus tracker in trusted embedded frames too.
manifest = Path('manifest.json')
s = manifest.read_text()
old = '''      "matches": [
        "https://casatrade.com/*",
        "https://*.casatrade.com/*",
        "https://casatrade.io/*",
        "https://*.casatrade.io/*"
      ],
      "js": [
        "src/content/focused-asset.js"
      ],
      "run_at": "document_start"
'''
new = '''      "matches": [
        "https://casatrade.com/*",
        "https://*.casatrade.com/*",
        "https://casatrade.io/*",
        "https://*.casatrade.io/*",
        "https://casatraders.online/*",
        "https://*.casatraders.online/*",
        "https://ivcasatraders.online/*",
        "https://*.ivcasatraders.online/*"
      ],
      "js": [
        "src/content/focused-asset.js"
      ],
      "run_at": "document_start",
      "all_frames": true,
      "match_origin_as_fallback": true
'''
assert old in s
s = s.replace(old, new, 1)
manifest.write_text(s)

# Regression tests: callback-only APIs and sticky mobile asset selection contract.
Path('test/mobile-browser-compat.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('chrome compat resolves callback-only storage APIs used by Android extension browsers', async () => {
  const backing = { scannerState: { asset: 'EUR/USD (OTC)' } };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, callback) {
          const out = typeof keys === 'string' ? { [keys]: backing[keys] } : { ...backing };
          queueMicrotask(() => callback(out));
          return undefined;
        },
        set(items, callback) {
          Object.assign(backing, items || {});
          queueMicrotask(() => callback());
          return undefined;
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete backing[key];
          queueMicrotask(() => callback());
          return undefined;
        }
      }
    }
  };
  const url = pathToFileURL(path.join(root, 'src/services/chrome-compat.js')).href + `?mobile=${Date.now()}`;
  const compat = await import(url);
  assert.deepEqual(await compat.storageLocalGet('scannerState'), { scannerState: { asset: 'EUR/USD (OTC)' } });
  await compat.storageLocalSet({ sample: 7 });
  assert.equal(backing.sample, 7);
  await compat.storageLocalRemove('sample');
  assert.equal(backing.sample, undefined);
});

test('mobile focus tracker keeps the user-selected asset authoritative and listens to touch events', () => {
  const focus = read('src/content/focused-asset.js');
  const augment = read('src/background-augment.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.doesNotMatch(focus, /USER_SELECTION_MS/);
  assert.match(focus, /if \(userSelection\)/);
  assert.match(focus, /!scanned\.explicit/);
  assert.match(focus, /event\.composedPath/);
  assert.match(focus, /addEventListener\('touchend'/);
  assert.match(focus, /explicit: candidate\.explicit === true/);
  assert.match(augment, /previousProtected/);
  assert.match(augment, /trustedEmbeddedVisual/);
  const focused = manifest.content_scripts.find(row => row.js?.includes('src/content/focused-asset.js'));
  assert.equal(focused.all_frames, true);
  assert.ok(focused.matches.some(value => value.includes('casatraders.online')));
});

test('sidepanel no longer depends on Promise-returning chrome APIs for startup', () => {
  const app = read('src/sidepanel/app.js');
  const atomic = read('src/services/scanner-state-atomic.js');
  assert.match(app, /function uiChromeCall/);
  assert.match(app, /uiStorageGet\(LAST_VALID_LICENSE_KEY\)/);
  assert.match(app, /uiSendMessage\(\{ type: 'ATS_READ_SCANNER_STATE' \}\)/);
  assert.match(app, /IDENTIFICANDO ATIVO ABERTO/);
  assert.match(atomic, /storageLocalGet\('scannerState'\)/);
  assert.doesNotMatch(atomic, /await originalGet/);
});
''')
