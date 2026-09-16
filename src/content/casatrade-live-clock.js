(() => {
  if (globalThis.__ATS_LIVE_CLOCK__) return;
  globalThis.__ATS_LIVE_CLOCK__ = true;
  const send = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof send !== 'function') return;
  let anchor=null,timer=null,lastSent=-1;
  const nowFromAnchor=()=>anchor ? anchor.epochAtAnchor+(performance.now()-anchor.perfAtAnchor) : Date.now();
  function schedule(){ if(timer) return; timer=setTimeout(tick,120); }
  function tick(){ timer=null; if(!anchor) return; const now=nowFromAnchor(); const ms=Math.max(0,anchor.closeAt-now); const sec=Math.ceil(ms/1000); if(sec!==lastSent || ms<1500){ lastSent=sec; send({type:'ATS_MARKET_CLOCK_V2',asset:anchor.asset,timeframe:anchor.timeframe,secondsRemaining:sec,millisecondsRemaining:Math.round(ms),closeAt:anchor.closeAt,expiration:anchor.expiration||null,available:true,verified:true,operational:true,clockRole:'candle-close',clockSource:'casatrade-platform-clock',clockMode:'ohlc-monotonic-anchor',clockText:'Fechamento ancorado no timestamp OHLC da CasaTrade',clockToken:`${sec}s`,confidence:98}).catch(()=>{}); } if(ms<=0){anchor=null;lastSent=-1;return;} schedule(); }
  window.addEventListener('ATS_NUMERIC_OHLC_CLOCK',event=>{
    const d=event.detail||{}; const openAt=Number(d.openAt),durationMs=Number(d.durationMs),sourceNow=Number(d.sourceNow||Date.now());
    if(!d.asset||!d.timeframe||!Number.isFinite(openAt)||!Number.isFinite(durationMs)||durationMs<=0) return;
    const closeAt=openAt+durationMs; if(sourceNow<openAt-1500||sourceNow>closeAt+1500) return;
    const localNow=Date.now(); const trustedSource=Math.abs(sourceNow-localNow)<=15000 ? sourceNow : localNow;
    anchor={asset:d.asset,timeframe:d.timeframe,expiration:d.expiration||null,closeAt,epochAtAnchor:trustedSource,perfAtAnchor:performance.now()};
    lastSent=-1; if(timer){clearTimeout(timer);timer=null;} tick();
  },true);
})();
