from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    if old not in text:
        raise AssertionError(f'missing target: {label}')
    return text.replace(old, new, 1)

# 1) User-selected asset remains authoritative until the user selects another asset.
path = 'src/content/focused-asset.js'
s = read(path)
old = """  function chooseCandidate() {
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
new = """  function chooseCandidate() {
    const scanned = focusedAssetCandidate();
    if (userSelection) {
      return { asset: userSelection.asset, score: Math.max(900, Number(scanned?.score || 0)), explicit: true, source: 'user-selection' };
    }
    if (scanned?.singleAsset && !scanned.explicit) return { ...scanned, source: 'single-frame-asset' };
    return scanned;
  }
"""
s = replace_once(s, old, new, 'sticky user selection')
write(path, s)

# 2) Service-worker memory loss cannot allow an old/foreign visual candidate to override stored user selection.
path = 'src/background-augment.js'
s = read(path)
old = """  const previousProtected = previousFocus?.source === 'user-selection' || previousFocus?.explicit === true;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused) && (!reliable || (previousProtected && !explicit))) return;

  focusedAssets.set(tabId, { asset: focused, score, samples, reliable, visual, source, explicit, frameId: sender.frameId, at: Date.now() });

  return updateScannerState(scannerState => {
"""
new = """  const incomingUserSelection = source === 'user-selection';
  const previousUserSelection = previousFocus?.source === 'user-selection';
  const previousProtected = previousUserSelection || previousFocus?.explicit === true;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused)) {
    if (previousUserSelection && !incomingUserSelection) return;
    if (!reliable || (previousProtected && !explicit)) return;
  }

  focusedAssets.set(tabId, { asset: focused, score, samples, reliable, visual, source, explicit, frameId: sender.frameId, at: Date.now() });

  return updateScannerState(scannerState => {
"""
s = replace_once(s, old, new, 'memory user focus priority')
old = """    const previousStored = scannerState.diagnostics?.focusedAsset || null;
    const sameStoredFocus = sameAsset(previousStored?.asset, focused);
    if (previousStored?.asset && !sameStoredFocus && !reliable) return;

    const changed = (!!previousFocus?.asset && !sameAsset(previousFocus.asset, focused)) || (!!previousStored?.asset && !sameStoredFocus);
"""
new = """    const previousStored = scannerState.diagnostics?.focusedAsset || null;
    const sameStoredFocus = sameAsset(previousStored?.asset, focused);
    const storedUserSelection = previousStored?.source === 'user-selection';
    if (previousStored?.asset && !sameStoredFocus) {
      if (storedUserSelection && !incomingUserSelection) return;
      if (!reliable) return;
    }

    const changed = (!!previousFocus?.asset && !sameAsset(previousFocus.asset, focused)) || (!!previousStored?.asset && !sameStoredFocus);
"""
s = replace_once(s, old, new, 'stored user focus priority')
old = """      ...(mustResetMarket ? {
        connection: 'connecting', asset: focused, price: null, candles: [], currentCandle: null,
        signal: null, lastConfirmed: null, tradeIntent: null, lastSeen: null
      } : {}),
"""
new = """      ...(mustResetMarket ? {
        connection: 'connecting', asset: focused, price: null, candles: [], currentCandle: null,
        signal: null, lastConfirmed: null, tradeIntent: null, lastSeen: null,
        timeframe: null, analysisTimeframe: null, expiration: null, targetExpiration: null,
        platformControls: null
      } : {}),
"""
s = replace_once(s, old, new, 'full market reset on focus switch')
write(path, s)

# 3) Direct scan must inspect the real trusted trader iframe, not only the CasaTrade shell.
path = 'src/background.js'
s = read(path)
old = """function scanCasaTradeFrame() {
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!(host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io'))) return null;
"""
new = """function scanCasaTradeFrame() {
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const casaHost = host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io');
  const traderHost = host === 'casatraders.online' || host.endsWith('.casatraders.online') || host === 'ivcasatraders.online' || host.endsWith('.ivcasatraders.online');
  if (!casaHost && !traderHost) return null;
"""
s = replace_once(s, old, new, 'direct scan trusted iframe')
write(path, s)

# 4) Overlay fails closed when its state does not match the asset actually visible in that frame.
path = 'src/content/analysis-visual-overlay.js'
s = read(path)
old = """  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const visible = el => {
"""
new = """  const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const clean = value => String(value ?? '').normalize('NFKC').replace(/\\s+/g, ' ').trim();
  const QUOTES = new Set(['USDT','USDC','USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','BRL','BTC','ETH']);
  const pairRe = /\\b([A-Z0-9]{2,16})\\s*[\\/_-]\\s*(USDT|USDC|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|BRL|BTC|ETH)(?:\\s*\\(\\s*OTC\\s*\\)|\\s+OTC)?/i;
  function canonicalAsset(value = '') {
    let raw = clean(value).toUpperCase();
    if (!raw || raw.length > 100) return '';
    const otc = /(?:\\(|\\b|[_-])OTC(?:\\)|\\b)?/.test(raw);
    let normalized = raw.replace(/\\(\\s*OTC\\s*\\)|\\bOTC\\b/g, '').replace(/^FRX[:_-]?/, '')
      .replace(/\\s+/g, '').replace(/_/g, '/').replace(/-/g, '/').replace(/:+/g, '/')
      .replace(/^\\/+|\\/+$/g, '').replace(/\\/{2,}/g, '/');
    if (!normalized.includes('/')) {
      const quote = [...QUOTES].find(item => normalized.length > item.length && normalized.endsWith(item));
      if (quote) normalized = `${normalized.slice(0, -quote.length)}/${quote}`;
    }
    const match = normalized.match(/^([A-Z0-9]{2,16})\\/([A-Z0-9]{2,12})$/);
    if (!match || !QUOTES.has(match[2])) return '';
    return `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}`;
  }
  const assetIdentity = value => canonicalAsset(value).replace(/\\s*\\(OTC\\)\\s*$/, '');
  const sameAsset = (a, b) => {
    const left = assetIdentity(a), right = assetIdentity(b);
    return !!left && !!right && left === right;
  };
  const visible = el => {
"""
s = replace_once(s, old, new, 'overlay asset normalization')
marker = """  const priceFromText = text => {
"""
insert = """  function localVisibleAsset() {
    const rows = [];
    for (const el of deepElements(5000)) {
      if (!visible(el)) continue;
      const text = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || '');
      if (!text || text.length > 120) continue;
      const match = text.match(pairRe);
      if (!match) continue;
      const asset = canonicalAsset(match[0]);
      if (!asset) continue;
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      const flags = `${el.className || ''} ${el.getAttribute?.('aria-selected') || ''} ${el.getAttribute?.('aria-current') || ''} ${el.getAttribute?.('data-state') || ''}`;
      const selected = /true|active|selected|current|checked/i.test(flags);
      if (role === 'tab' && !selected) continue;
      const rect = el.getBoundingClientRect();
      const context = `${el.id || ''} ${el.className || ''} ${el.parentElement?.className || ''}`.toLowerCase();
      let score = selected ? 500 : 0;
      if (role !== 'tab') score += 100;
      if (rect.top >= 0 && rect.top < innerHeight * .55) score += 45;
      if (text.length < 45) score += 35;
      if (/chart|trade|trading|instrument|asset|symbol|header/.test(context)) score += 120;
      if (/watchlist|listbox|history|portfolio|dropdown|menu|drawer/.test(context) && !selected) score -= 260;
      rows.push({ asset, score });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows[0]?.asset || '';
  }

  function overlayMatchesVisibleAsset() {
    const stateAsset = canonicalAsset(scannerState?.asset || '');
    const lastSeen = Number(scannerState?.lastSeen || 0);
    if (!stateAsset || !Number.isFinite(lastSeen) || lastSeen <= 0 || Date.now() - lastSeen > 8000) return false;
    const visibleAsset = localVisibleAsset();
    if (!visibleAsset) return false;
    return sameAsset(visibleAsset, stateAsset);
  }

"""
if marker not in s:
    raise AssertionError('missing target: overlay insertion')
s = s.replace(marker, insert + marker, 1)
old = """    if (!prefs.overlayEnabled || !scannerState || scannerState.platformId !== 'casatrade' || !scannerState.asset) {
"""
new = """    if (!prefs.overlayEnabled || !scannerState || scannerState.platformId !== 'casatrade' || !scannerState.asset || !overlayMatchesVisibleAsset()) {
"""
s = replace_once(s, old, new, 'overlay mismatch gate')
write(path, s)

# 5) Regressions for the exact problems visible in the user's recording.
write('test/live-video-asset-switch.test.mjs', r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('user-selected asset stays authoritative until another real user selection', () => {
  const focused = read('src/content/focused-asset.js');
  const augment = read('src/background-augment.js');
  assert.match(focused, /if \(userSelection\) \{\s*return \{ asset: userSelection\.asset/s);
  assert.doesNotMatch(focused, /userSelection = null/);
  assert.match(augment, /previousUserSelection && !incomingUserSelection/);
  assert.match(augment, /storedUserSelection && !incomingUserSelection/);
});

test('asset switch clears every operational field that could leak the previous pair', () => {
  const augment = read('src/background-augment.js');
  const reset = augment.match(/\.\.\.\(mustResetMarket \? \{([\s\S]*?)\} : \{\}\)/)?.[1] || '';
  for (const field of ['price: null','candles: []','currentCandle: null','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null','timeframe: null','analysisTimeframe: null','expiration: null','targetExpiration: null','platformControls: null']) {
    assert.ok(reset.includes(field), `missing reset field: ${field}`);
  }
});

test('direct scan includes trusted embedded trader frame where the live chart may reside', () => {
  const background = read('src/background.js');
  assert.match(background, /const traderHost = host === 'casatraders\.online'/);
  assert.match(background, /ivcasatraders\.online/);
  assert.match(background, /if \(!casaHost && !traderHost\) return null/);
});

test('overlay never draws stale SHIB-scale analysis on a different visible asset', () => {
  const overlay = read('src/content/analysis-visual-overlay.js');
  assert.match(overlay, /function localVisibleAsset\(\)/);
  assert.match(overlay, /function overlayMatchesVisibleAsset\(\)/);
  assert.match(overlay, /Date\.now\(\) - lastSeen > 8000/);
  assert.match(overlay, /sameAsset\(visibleAsset, stateAsset\)/);
  assert.match(overlay, /!overlayMatchesVisibleAsset\(\)/);
});
''')

print('final live-video fixes applied')
