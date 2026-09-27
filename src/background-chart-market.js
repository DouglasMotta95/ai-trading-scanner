import { updateScannerState } from './services/scanner-state-atomic.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
const traderHost = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
const licenseActive = state => ['active', 'valid'].includes(String(state?.license?.status || '').toLowerCase());

function normAsset(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw || raw.length > 100) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const direct = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  if (direct) return `${direct[1]}/${direct[2]}${otc ? ' (OTC)' : ''}`;
  const compact = raw.match(/\b([A-Z]{3})([A-Z]{3})\b/);
  return compact ? `${compact[1]}/${compact[2]}${otc ? ' (OTC)' : ''}` : '';
}

const identity = value => normAsset(value).replace(/\s*\(OTC\)\s*$/i, '');
const sameAsset = (a, b) => !!identity(a) && identity(a) === identity(b);

function senderMeta(sender = {}) {
  let frameHost = '', topHost = '';
  try { frameHost = new URL(sender.url || '').hostname.toLowerCase(); } catch {}
  try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
  return {
    trusted: !!sender.tab?.id && sender.frameId !== 0 && traderHost(frameHost) && casaHost(topHost),
    frameHost,
    topHost,
    frameId: sender.frameId,
    tabId: sender.tab?.id || null
  };
}

async function applyChartPrice(message = {}, sender = {}) {
  const info = senderMeta(sender);
  if (!info.trusted) return;
  const asset = normAsset(message.asset);
  const price = num(message.price);
  if (!asset || price == null || price <= 0) return;

  return updateScannerState(state => {
    if (!licenseActive(state)) return;
    if (state.targetTabId && state.targetTabId !== info.tabId) return;
    const focus = state.diagnostics?.focusedAsset || null;
    const sameAuthoritativeFrame = focus?.reliable === true
      && focus?.chartScoped === true
      && focus?.embeddedTrader === true
      && sameAsset(focus?.asset, asset)
      && Number(focus?.frameId) === Number(info.frameId)
      && clean(focus?.frameHost).toLowerCase() === info.frameHost;
    if (!sameAuthoritativeFrame) return;

    const clock = state.diagnostics?.marketClock || null;
    const clockReady = clock?.verified === true
      && clean(clock?.role) === 'candle-close'
      && sameAsset(clock?.asset, asset)
      && Number(clock?.frameId) === Number(info.frameId)
      && clean(clock?.frameHost).toLowerCase() === info.frameHost
      && Date.now() - Number(clock?.at || 0) < 2200;

    return {
      ...state,
      targetTabId: info.tabId,
      platformId: 'casatrade',
      platformName: 'CasaTrade',
      scanner: 'scanning',
      connection: 'online',
      asset,
      price,
      lastSeen: Date.now(),
      ...(!clockReady ? { signal: null } : {}),
      diagnostics: {
        ...(state.diagnostics || {}),
        acquisition: {
          ...(state.diagnostics?.acquisition || {}),
          stage: Array.isArray(state.candles) && state.candles.length >= 2
            ? (clockReady ? 'diagnosing_next_candle' : 'syncing_clock')
            : 'reading_history',
          reason: Array.isArray(state.candles) && state.candles.length >= 2
            ? (clockReady ? 'Cotação e relógio da vela sincronizados.' : 'Cotação do gráfico pronta. Sincronizando o fechamento real da vela.')
            : `Cotação do gráfico pronta. Carregando histórico real • ${state.candles?.length || 0}/2 velas.`,
          priceSource: clean(message.priceSource || 'visible-chart'),
          candleCount: Array.isArray(state.candles) ? state.candles.length : 0,
          requiredCandles: 2,
          at: Date.now()
        },
        chartMarket: {
          price,
          source: clean(message.priceSource || 'visible-chart'),
          confidence: Number(message.confidence || 0),
          frameId: info.frameId,
          frameHost: info.frameHost,
          at: Date.now()
        }
      }
    };
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'ATS_CHART_FRAME_MARKET') {
    setTimeout(() => applyChartPrice(message, sender).catch(() => {}), 0);
  }
});
