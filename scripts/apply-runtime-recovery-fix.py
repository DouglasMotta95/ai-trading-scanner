from pathlib import Path
import json


def require_replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f"{path}: anchor not found ({old[:100]!r})")
    p.write_text(text.replace(old, new, count))


def replace_between(path, start, end, new_block):
    p = Path(path)
    text = p.read_text()
    i = text.find(start)
    if i < 0:
        raise SystemExit(f"{path}: start marker not found: {start!r}")
    j = text.find(end, i + len(start))
    if j < 0:
        raise SystemExit(f"{path}: end marker not found: {end!r}")
    p.write_text(text[:i] + new_block.rstrip() + "\n\n" + text[j:])


# 1) Version and focused-asset reader coverage.
mp = Path('manifest.json')
manifest = json.loads(mp.read_text())
manifest['version'] = '0.10.4'
focus_script = next(x for x in manifest['content_scripts'] if 'src/content/focused-asset.js' in (x.get('js') or []))
for host in [
    'https://casatraders.online/*', 'https://*.casatraders.online/*',
    'https://ivcasatraders.online/*', 'https://*.ivcasatraders.online/*'
]:
    if host not in focus_script['matches']:
        focus_script['matches'].append(host)
focus_script['all_frames'] = True
focus_script['match_origin_as_fallback'] = True
mp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')

# Runtime reinjection must also cover every accessible frame on an already-open CasaTrade tab.
require_replace(
    'src/background.js',
    "{ file: 'src/content/focused-asset.js', world: 'ISOLATED', allFrames: false },",
    "{ file: 'src/content/focused-asset.js', world: 'ISOLATED', allFrames: true },"
)

# 2) Focus from child/opaque/embedded frames, while the owning top tab remains CasaTrade.
replace_between(
    'src/background-augment.js',
    'async function setFocusedAsset(message = {}, sender = {}) {',
    'async function applyEmbeddedFeed',
    '''async function setFocusedAsset(message = {}, sender = {}) {
  const focused = normAsset(message.asset);
  if (!focused || !sender?.tab?.id) return;

  let senderHost = '';
  let topHost = '';
  try { senderHost = new URL(sender.url || '').hostname; } catch {}
  try { topHost = new URL(sender.tab.url || '').hostname; } catch {}
  if (!isCasaTradeHost(topHost)) return;

  const topFrame = sender.frameId === 0;
  const embeddedFrame = trustedEmbeddedHost(senderHost);
  const opaqueFrame = !senderHost;
  if (!topFrame && !embeddedFrame && !opaqueFrame && !isCasaTradeHost(senderHost)) return;

  const tabId = sender.tab.id;
  const previousFocus = focusedAssets.get(tabId) || null;
  const rawScore = Number(message.score || 0);
  const samples = Number(message.samples || 0);
  const source = clean(message.source || 'chart-header');
  const score = rawScore + (topFrame ? 80 : 0) + (source === 'user-selection' ? 220 : 0);
  const visual = message.visual === true || source === 'chart-header' || source === 'user-selection';
  const reliable = message.reliable === true || source === 'user-selection' || score >= FOCUS_CHANGE_MIN_SCORE || samples >= 2;
  const previousUserSelection = previousFocus?.source === 'user-selection'
    && Date.now() - Number(previousFocus?.at || 0) < 5000;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused) && previousUserSelection && source !== 'user-selection') return;
  if (previousFocus?.asset && !sameAsset(previousFocus.asset, focused) && !reliable) return;

  focusedAssets.set(tabId, {
    asset: focused, score, samples, reliable, visual, source,
    frameId: Number(sender.frameId ?? 0), frameHost: senderHost || null, at: Date.now()
  });

  return updateScannerState(scannerState => {
    if (!licenseActive(scannerState)) return;
    if (scannerState.targetTabId && scannerState.targetTabId !== tabId) return;

    const previousStored = scannerState.diagnostics?.focusedAsset || null;
    const sameStoredFocus = sameAsset(previousStored?.asset, focused);
    if (previousStored?.asset && !sameStoredFocus && !reliable) return;

    const changed = (!!previousFocus?.asset && !sameAsset(previousFocus.asset, focused)) || (!!previousStored?.asset && !sameStoredFocus);
    const stateAssetMismatch = scannerState.asset && !sameAsset(scannerState.asset, focused);
    const mustResetMarket = (changed || stateAssetMismatch) && reliable;
    const stableSince = sameStoredFocus ? Number(previousStored?.stableSince || previousStored?.at || Date.now()) : Date.now();
    if (mustResetMarket) resetOrchestrator();

    return {
      ...scannerState,
      targetTabId: tabId,
      ...(mustResetMarket ? {
        connection: 'connecting', asset: focused, price: null, candles: [], currentCandle: null,
        signal: null, lastConfirmed: null, tradeIntent: null, lastSeen: null
      } : {}),
      diagnostics: {
        ...(scannerState.diagnostics || {}),
        focusedAsset: {
          asset: focused, at: Date.now(), stableSince,
          changedAt: mustResetMarket ? Date.now() : Number(previousStored?.changedAt || stableSince),
          score, samples, reliable, visual, source,
          frameId: Number(sender.frameId ?? 0), frameHost: senderHost || null
        },
        ...(mustResetMarket ? {
          acquisition: {
            stage: 'reading_price',
            reason: `Ativo ${focused} confirmado na tela. Aguardando preço real do mesmo ativo.`,
            assetSource: source === 'user-selection' ? 'focused-user-selection' : 'focused-screen',
            priceSource: null, candleCount: 0, requiredCandles: 2, at: Date.now()
          }
        } : {})
      }
    };
  });
}'''
)

# 3) Direct scan: it is already constrained to the chosen CasaTrade tab, so inspect every accessible frame.
require_replace(
    'src/background.js',
    """function scanCasaTradeFrame() {
  const host = String(location.hostname || '').toLowerCase().replace(/\\.$/, '');
  if (!(host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io'))) return null;

""",
    """function scanCasaTradeFrame() {
  const frameUrl = String(location.href || '');

"""
)
require_replace('src/background.js', 'score, frameUrl: location.href', 'score, frameUrl')

# Reliable focus in one frame may use a price rendered in another frame.
require_replace(
    'src/background.js',
    """    const focusRows = focus ? rows.filter(x => x.asset && sameAsset(x.asset, focus)) : [];
    const bestFocused = focusRows.find(x => x.asset && num(x.price) != null) || null;
    const bestFocusAssetOnly = focusRows.find(x => x.asset) || null;
    const bestFallback = focus ? null : (rows.find(x => x.asset && num(x.price) != null) || rows.find(x => x.asset) || null);
    const priceOnly = focus ? null : (rows.find(x => num(x.price) != null) || null);
    const best = focus ? (bestFocused || bestFocusAssetOnly) : (bestFallback || priceOnly);
    const observedAsset = focus || normAsset(best?.asset || '');
    const observedPrice = focus ? num(bestFocused?.price) : num(best?.price);
""",
    """    const focusRows = focus ? rows.filter(x => x.asset && sameAsset(x.asset, focus)) : [];
    const bestFocused = focusRows.find(x => x.asset && num(x.price) != null) || null;
    const bestFocusAssetOnly = focusRows.find(x => x.asset) || null;
    const reliableFocus = !!focus && focusMeta?.reliable === true;
    const focusedPriceOnly = reliableFocus
      ? rows.find(x => !x.asset && num(x.price) != null && Number(x.score || 0) >= 45)
      : null;
    const bestFallback = focus ? null : (rows.find(x => x.asset && num(x.price) != null) || rows.find(x => x.asset) || null);
    const priceOnly = focus ? focusedPriceOnly : (rows.find(x => num(x.price) != null) || null);
    const best = focus ? (bestFocused || bestFocusAssetOnly || focusedPriceOnly) : (bestFallback || priceOnly);
    const observedAsset = focus || normAsset(best?.asset || '');
    const observedPrice = focus ? (num(bestFocused?.price) ?? num(focusedPriceOnly?.price)) : num(best?.price);
"""
)

# 4) Keep Phase C floor 80, but score corroborated real DOM capture according to its evidence.
replace_between(
    'src/background.js',
    'function feedQuality(state = {}) {',
    'function latencyOf(state = {}) {',
    '''function feedQuality(state = {}) {
  if (state.connection !== 'online' || state.price == null) return 0;
  const qualities = [];
  const reported = Number(state.diagnostics?.network?.feedQuality);
  if (Number.isFinite(reported) && reported > 0) qualities.push(Math.max(0, Math.min(100, reported)));
  if (state.capabilities?.structuredQuotes) qualities.push(100);

  const focus = state.diagnostics?.focusedAsset || null;
  const focusFresh = focus?.reliable === true
    && sameAsset(focus?.asset, state.asset)
    && Number(focus?.at || 0) > 0
    && Date.now() - Number(focus.at) < 6000;
  const direct = state.diagnostics?.directScan || null;
  const directFresh = Number(direct?.at || 0) > 0
    && Date.now() - Number(direct.at) < 6000
    && !!state.diagnostics?.priceSource;
  const directAssetCorroborated = directFresh
    && Number(direct?.score || 0) >= 90
    && ['dom-fallback', 'focused-screen', 'focused-stable', 'focused-user-selection'].includes(String(state.diagnostics?.assetSource || ''));

  if ((focusFresh && directFresh) || directAssetCorroborated) {
    qualities.push(state.capabilities?.candles || (Array.isArray(state.candles) && state.candles.length >= 2) ? 90 : 85);
  } else if (directFresh && state.asset) {
    qualities.push(75);
  }

  if (!qualities.length && state.asset && state.price != null) qualities.push(65);
  return Math.max(0, Math.min(100, ...qualities));
}'''
)

# 5) Break focus->feed deadlock using only strong network evidence until visual focus exists.
replace_between(
    'src/content/network-bridge.js',
    "  function bestCandidate(payload = {}, preferredAsset = '') {",
    '  function historyFor(payload = {}, asset = \'\') {',
    '''  function bestCandidate(payload = {}, preferredAsset = '') {
    const wanted = assetBase(preferredAsset);
    let rows = (Array.isArray(payload.candidates) ? payload.candidates : []).map(c => {
      const asset = canonicalAsset(c?.asset);
      const price = num(c?.price) ?? (num(c?.bid) != null && num(c?.ask) != null ? (num(c.bid) + num(c.ask)) / 2 : null);
      return { ...c, asset, price };
    }).filter(c => c.asset && c.price != null && c.price > 0);

    if (wanted) rows = rows.filter(c => sameAsset(c.asset, preferredAsset));
    rows.sort((a, b) =>
      Number(b?.selected === true) - Number(a?.selected === true)
      || Number(b?.confidence || 0) - Number(a?.confidence || 0)
      || Number(b?.seenCount || 0) - Number(a?.seenCount || 0)
      || Number(b?.observedAt || 0) - Number(a?.observedAt || 0)
    );
    const candidate = rows[0] || null;
    if (wanted) return candidate;
    if (!candidate) return null;
    const strong = candidate.selected === true
      || Number(candidate.confidence || 0) >= 82
      || Number(candidate.seenCount || 0) >= 2;
    return strong ? candidate : null;
  }'''
)

replace_between(
    'src/content/network-bridge.js',
    "  function sendSnapshot({ asset, price, timeframe = 'M1', expiration = null, secondsRemaining = null, candles = [], source = 'market', feedQuality = 0, structured = false }) {",
    '  function publishToExtension(payload = {}) {',
    '''  function sendSnapshot({ asset, price, timeframe = 'M1', expiration = null, secondsRemaining = null, candles = [], source = 'market', feedQuality = 0, structured = false, allowUnfocused = false }) {
    const focus = focusedAsset();
    const cleanAsset = canonicalAsset(asset);
    const resolvedAsset = focus && cleanAsset && sameAsset(cleanAsset, focus)
      ? focus
      : (!focus && allowUnfocused ? cleanAsset : '');
    if (!resolvedAsset || price == null) return;
    chrome.runtime.sendMessage({
      type: 'ATS_PLATFORM_SNAPSHOT',
      payload: {
        platformId: 'casatrade',
        platformName: 'CasaTrade',
        connection: 'online',
        asset: resolvedAsset,
        price: Number(price),
        timeframe,
        analysisTimeframe: timeframe,
        expiration,
        secondsRemaining: Number.isFinite(Number(secondsRemaining)) ? Number(secondsRemaining) : null,
        instrumentType: 'unknown',
        marketType: /\\(OTC\\)/i.test(resolvedAsset) ? 'otc' : 'regular',
        serverTime: null,
        candles: Array.isArray(candles) ? candles.slice(-120) : [],
        ticks: [{ price: Number(price), at: Date.now() }],
        capabilities: {
          structuredQuotes: !!structured,
          candles: Array.isArray(candles) && candles.length >= 3,
          expiration: !!expiration,
          multiAsset: false
        },
        diagnostics: {
          capture: source,
          feedQuality: Number(feedQuality || 0),
          relayed: true,
          filteredTo: resolvedAsset
        }
      }
    }).catch(() => {});
  }'''
)

replace_between(
    'src/content/network-bridge.js',
    '  function publishToExtension(payload = {}) {',
    '  function deepText() {',
    '''  function publishToExtension(payload = {}) {
    chrome.runtime.sendMessage({ type: 'ATS_NETWORK_DIAGNOSTIC', payload }).catch(() => {});

    const focus = focusedAsset();
    const candidate = bestCandidate(payload, focus);
    if (!candidate) return;
    if (focus && !sameAsset(candidate.asset, focus)) return;
    const resolvedAsset = focus || canonicalAsset(candidate.asset);
    if (!resolvedAsset) return;

    const price = Number(candidate.price);
    const networkHistory = historyFor(payload, resolvedAsset);
    const timeframe = selectedTimeframeFromDom() || candidate.timeframe || networkHistory.at(-1)?.timeframe || 'M1';
    const expiration = selectedExpirationFromDom() || candidate.expiration || null;
    const secondsRemaining = countdownFromDom(timeframe);
    const localHistory = updateLocalCandle(resolvedAsset, price, timeframe);
    const candles = networkHistory.length >= 2 ? networkHistory : localHistory;

    sendSnapshot({
      asset: resolvedAsset,
      price,
      timeframe,
      expiration,
      secondsRemaining,
      candles,
      source: `top-frame-relay:${candidate.transport || payload.primaryTransport || 'market'}`,
      feedQuality: payload.feedQuality,
      structured: candidate.transport !== 'rendered',
      allowUnfocused: !focus
    });
  }'''
)

# 6) Stable device identity across a clean reinstall when manifest key preserves chrome.runtime.id.
replace_between(
    'src/services/telemetry.js',
    'const randomInstallationId = () => `ats-install-${crypto.randomUUID()}`;',
    'export async function clientToken() {',
    '''const randomInstallationId = () => `ats-install-${crypto.randomUUID()}`;
const stableRuntimeInstallationId = () => {
  const runtimeId = String(chrome.runtime?.id || '').trim();
  return runtimeId ? `ats-device-${runtimeId}` : '';
};
let installationIdPromise = null;

export async function installationId() {
  if (installationIdPromise) return installationIdPromise;
  installationIdPromise = (async () => {
    const x = await chrome.storage.local.get(INSTALL_KEY);
    const existing = String(x[INSTALL_KEY] || '').trim();
    if (existing) return existing;

    const id = stableRuntimeInstallationId() || randomInstallationId();
    await chrome.storage.local.set({ [INSTALL_KEY]: id });
    const persisted = await chrome.storage.local.get(INSTALL_KEY);
    return String(persisted[INSTALL_KEY] || id).trim() || id;
  })();
  try {
    return await installationIdPromise;
  } finally {
    installationIdPromise = null;
  }
}'''
)

# 7) Refresh/exchange must not erase a valid stored license key when response omits it.
require_replace(
    'src/sidepanel/account-login.js',
    """  async function saveSession(r) {
    const values = {
      [LICENSE_KEY]: String(r.licenseKey || ''),
""",
    """  async function saveSession(r) {
    const previous = await chrome.storage.local.get(LICENSE_KEY);
    const incomingLicenseKey = String(r.licenseKey || r.license?.key || '').trim();
    const preservedLicenseKey = incomingLicenseKey || String(previous[LICENSE_KEY] || '').trim();
    const values = {
      [LICENSE_KEY]: preservedLicenseKey,
"""
)
require_replace(
    'src/sidepanel/account-login.js',
    "licenseKey: String(r.licenseKey || r.license?.key || ''),",
    'licenseKey: preservedLicenseKey,'
)

# Existing device-identity tests now assert stable runtime id + preservation of old binding.
p = Path('test/production-hardening.test.mjs')
t = p.read_text()
start = t.index("test('telemetry installationId generates one UUID")
end = t.index("test('account login imports", start)
new_tests = '''test('telemetry installationId is stable for the same extension runtime id', async () => {
  await withInstallationGlobals({ uuid: '11111111-1111-4111-8111-111111111111' }, async ({ telemetry, values, uuidCalls }) => {
    const ids = await Promise.all([telemetry.installationId(), telemetry.installationId(), telemetry.installationId()]);
    const expected = 'ats-device-shared-extension-runtime-id';
    assert.deepEqual(ids, [expected, expected, expected]);
    assert.equal(values.atsInstallationId, expected);
    assert.equal(uuidCalls(), 0);
  });
});

test('telemetry preserves an existing bound installation id', async () => {
  await withInstallationGlobals({
    initial: { atsInstallationId: 'ats-install-existing-device' },
    uuid: '22222222-2222-4222-8222-222222222222'
  }, async ({ telemetry, values, uuidCalls }) => {
    const id = await telemetry.installationId();
    assert.equal(id, 'ats-install-existing-device');
    assert.equal(values.atsInstallationId, 'ats-install-existing-device');
    assert.equal(uuidCalls(), 0);
  });
});

'''
p.write_text(t[:start] + new_tests + t[end:])

# Update static focus assertion for the cross-frame price fallback.
require_replace(
    'test/focused-asset-lock.test.mjs',
    "assert.match(background, /const observedPrice = focus \\? num\\(bestFocused\\?\\.price\\)/);",
    "assert.match(background, /const observedPrice = focus \\? \\(num\\(bestFocused\\?\\.price\\) \\?\\? num\\(focusedPriceOnly\\?\\.price\\)\\)/);"
)

# New regression coverage for the exact bugs observed live.
Path('test/runtime-recovery-regressions.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('focused asset capture runs in embedded and origin-fallback frames', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const block = manifest.content_scripts.find(x => (x.js || []).includes('src/content/focused-asset.js'));
  assert.equal(block.all_frames, true);
  assert.equal(block.match_origin_as_fallback, true);
  assert.ok(block.matches.some(x => x.includes('casatraders.online')));
  assert.ok(block.matches.some(x => x.includes('ivcasatraders.online')));
  const background = read('src/background.js');
  assert.match(background, /focused-asset\.js', world: 'ISOLATED', allFrames: true/);
});

test('focused asset handler accepts validated CasaTrade child frames', () => {
  const source = read('src/background-augment.js');
  assert.doesNotMatch(source, /sender\.frameId !== 0/);
  assert.match(source, /isCasaTradeHost\(topHost\)/);
  assert.match(source, /opaqueFrame/);
  assert.match(source, /frameId: Number\(sender\.frameId/);
});

test('direct scan no longer discards opaque or embedded frames by frame hostname', () => {
  const source = read('src/background.js');
  const start = source.indexOf('function scanCasaTradeFrame()');
  const end = source.indexOf('function historyForAsset', start);
  const scan = source.slice(start, end);
  assert.match(scan, /const frameUrl = String\(location\.href/);
  assert.doesNotMatch(scan, /host === 'casatrade\.com'/);
});

test('strong network candidate can bootstrap asset before visual focus exists', () => {
  const source = read('src/content/network-bridge.js');
  assert.match(source, /allowUnfocused/);
  assert.match(source, /Number\(candidate\.confidence \|\| 0\) >= 82/);
  assert.match(source, /Number\(candidate\.seenCount \|\| 0\) >= 2/);
  assert.match(source, /const resolvedAsset = focus \|\| canonicalAsset\(candidate\.asset\)/);
});

test('corroborated direct DOM evidence can satisfy the existing 80 percent confirmation floor', () => {
  const source = read('src/background.js');
  assert.match(source, /directAssetCorroborated/);
  assert.match(source, /\? 90 : 85/);
  assert.match(source, /confirmationFeedQuality < 80/);
  assert.match(source, /minimum: 80/);
});

test('account session refresh preserves a previously stored license key', () => {
  const source = read('src/sidepanel/account-login.js');
  assert.match(source, /preservedLicenseKey/);
  assert.match(source, /incomingLicenseKey \|\| String\(previous\[LICENSE_KEY\]/);
  assert.doesNotMatch(source, /\[LICENSE_KEY\]: String\(r\.licenseKey \|\| ''\)/);
});
''')

print('runtime recovery patch applied')
