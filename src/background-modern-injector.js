import { updateScannerState } from './services/scanner-state-atomic.js';

const cleanError = value => String(value?.message || value || '').replace(/\s+/g, ' ').trim().slice(0, 220);
function executeScriptCompat(details) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; error ? reject(error) : resolve(Array.isArray(result) ? result : []); };
    const callback = result => {
      let runtimeError = null; try { runtimeError = chrome.runtime?.lastError || null; } catch {}
      finish(runtimeError ? new Error(runtimeError.message || String(runtimeError)) : null, result);
    };
    try {
      const returned = chrome.scripting.executeScript(details, callback);
      if (returned && typeof returned.then === 'function') returned.then(result => finish(null, result)).catch(error => finish(error));
    } catch (error) { finish(error); }
  });
}
function inspectFrame() {
  const describe = value => {
    try { const url = new URL(String(value || ''), location.href); return { protocol: String(url.protocol || '').slice(0,16), host: String(url.hostname || '').toLowerCase().replace(/\.$/,'').slice(0,120), opaque: ['blob:','about:','data:'].includes(String(url.protocol || '').toLowerCase()), srcdoc: false }; }
    catch { return { protocol:'', host:'', opaque:false, srcdoc:false }; }
  };
  const hints = [];
  if (window === window.top) for (const frame of [...document.querySelectorAll('iframe')].slice(0,16)) { const row = describe(frame.getAttribute('src') || 'about:blank'); row.srcdoc = frame.hasAttribute('srcdoc'); hints.push(row); }
  let referrerHost = ''; try { referrerHost = new URL(document.referrer || '').hostname.toLowerCase().replace(/\.$/,'').slice(0,120); } catch {}
  return { protocol:String(location.protocol || '').slice(0,16), host:String(location.hostname || '').toLowerCase().replace(/\.$/,'').slice(0,120), referrerHost, isTop:window===window.top, readyState:String(document.readyState || '').slice(0,24), iframeHints:hints };
}
const frameRows = results => (Array.isArray(results) ? results : []).slice(0,30).map(row => ({ frameId:Number.isFinite(Number(row?.frameId)) ? Number(row.frameId) : null, protocol:String(row?.result?.protocol || '').slice(0,16), host:String(row?.result?.host || '').slice(0,120), referrerHost:String(row?.result?.referrerHost || '').slice(0,120), isTop:row?.result?.isTop===true, readyState:String(row?.result?.readyState || '').slice(0,24), iframeHints:Array.isArray(row?.result?.iframeHints) ? row.result.iframeHints.slice(0,16) : [] }));
async function probeFrames(tabId) {
  const target = { tabId, allFrames:true };
  try { const result = await executeScriptCompat({ target, func:inspectFrame, world:'ISOLATED' }); return { ok:true, mode:'isolated-world', frameCount:result.length, frames:frameRows(result), error:'' }; }
  catch (firstError) {
    try { const result = await executeScriptCompat({ target, func:inspectFrame }); return { ok:true, mode:'default-world-fallback', frameCount:result.length, frames:frameRows(result), firstError:cleanError(firstError), error:'' }; }
    catch (secondError) { return { ok:false, mode:'failed', frameCount:0, frames:[], firstError:cleanError(firstError), error:cleanError(secondError) }; }
  }
}
async function injectFile(tabId, file, world) {
  const target = { tabId, allFrames:true };
  try { const result = await executeScriptCompat({ target, files:[file], world }); return { file, world, ok:true, mode:`${String(world).toLowerCase()}-world`, frameCount:result.length, error:'' }; }
  catch (firstError) {
    if (world === 'ISOLATED') {
      try { const result = await executeScriptCompat({ target, files:[file] }); return { file, world, ok:true, mode:'default-world-fallback', frameCount:result.length, firstError:cleanError(firstError), error:'' }; }
      catch (secondError) { return { file, world, ok:false, mode:'failed', frameCount:0, firstError:cleanError(firstError), error:cleanError(secondError) }; }
    }
    return { file, world, ok:false, mode:'failed', frameCount:0, error:cleanError(firstError) };
  }
}
async function recordInjection(tabId, startedAt, probe, rows) {
  const endedAt = Date.now();
  const isolated = rows.filter(row => row.world === 'ISOLATED'), main = rows.filter(row => row.world === 'MAIN');
  const failures = rows.filter(row => !row.ok).map(row => ({ file:row.file, world:row.world, error:row.error || row.firstError || 'unknown' })).slice(0,20);
  const telemetry = { tabId, startedAt, endedAt, durationMs:Math.max(0,endedAt-startedAt), probe, isolated:{ total:isolated.length, ok:isolated.filter(row=>row.ok).length, fallback:isolated.filter(row=>row.mode==='default-world-fallback').length }, main:{ total:main.length, ok:main.filter(row=>row.ok).length }, failures };
  await updateScannerState(state => ({ ...state, diagnostics:{ ...(state.diagnostics || {}), runtimeInjection:telemetry } })).catch(() => {});
  return telemetry;
}
async function inject(tabId) {
  const startedAt = Date.now();
  if (!tabId || !chrome.scripting?.executeScript) { const probe={ok:false,mode:'scripting-api-unavailable',frameCount:0,frames:[],error:'chrome.scripting.executeScript unavailable'}; await recordInjection(tabId || null,startedAt,probe,[]); return false; }
  const isolated = [
    'src/content/runtime-message-compat.js','src/content/runtime-boot-probe.js','src/content/page-world-bootstrap.js','src/content/opaque-frame-top-bridge.js','src/content/opaque-frame-recovery.js','src/content/device-anchor.js',
    'src/content/focused-asset-alias-bridge.js','src/content/focused-asset-protocol.js','src/content/focused-asset-v2.js','src/content/chart-frame-market-reader.js','src/content/embedded-feed-bridge.js','src/content/platform-sync.js','src/content/casatrade-ui-observer-v2.js','src/content/market-cycle-clock-v4.js','src/content/market-clock-projector.js','src/content/casatrade-expiration-probe.js','src/content/casatrade-data-inspector.js','src/content/analysis-visual-overlay-v2.js','src/content/manual-trade-observer.js','src/content/account-metrics-observer.js','src/content/trade-handoff-v2.js'
  ];
  const mainWorld = ['src/content/page-world-sentinel.js','src/content/canvas-countdown-probe.js','src/content/standalone-instrument-probe.js','src/content/worker-probe.js','src/content/canvas-probe.js','src/content/network-probe.js'];
  const probe = await probeFrames(tabId), rows = [];
  for (const file of isolated) rows.push(await injectFile(tabId,file,'ISOLATED'));
  for (const file of mainWorld) rows.push(await injectFile(tabId,file,'MAIN'));
  const telemetry = await recordInjection(tabId,startedAt,probe,rows);
  return telemetry.isolated.ok > 0 || telemetry.main.ok > 0;
}
globalThis.__ATS_INJECT_MODERN_PIPELINE__ = inject;
