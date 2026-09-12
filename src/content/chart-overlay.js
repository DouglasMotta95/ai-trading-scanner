(()=>{
  if(globalThis.__ATS_CHART_OVERLAY__)return;globalThis.__ATS_CHART_OVERLAY__=true;
  let overlay=null,lastKey='';
  const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>220&&r.height>140&&s.display!=='none'&&s.visibility!=='hidden'};
  const chartTarget=()=>[...document.querySelectorAll('canvas,svg,[class*="chart" i],[id*="chart" i]')].filter(visible).map(el=>({el,r:el.getBoundingClientRect()})).filter(x=>x.r.width*x.r.height>50000).sort((a,b)=>b.r.width*b.r.height-a.r.width*a.r.height)[0]||null;
  const ensure=()=>{if(overlay?.isConnected)return overlay;overlay=document.createElement('div');overlay.id='ats-chart-overlay';Object.assign(overlay.style,{position:'fixed',zIndex:'2147483000',pointerEvents:'none',display:'none',overflow:'hidden',borderRadius:'8px'});overlay.innerHTML='<svg width="100%" height="100%" preserveAspectRatio="none"></svg>';document.documentElement.appendChild(overlay);return overlay};
  const finite=v=>Number.isFinite(Number(v))?Number(v):null;
  const lineY=(v,range,h)=>h-(v-range.min)/(range.max-range.min||1)*h;
  const shortFromRows=rows=>{const recent=rows.slice(-5);if(recent.length<3)return null;const lows=recent.map(x=>finite(x.low)).filter(Number.isFinite),highs=recent.map(x=>finite(x.high)).filter(Number.isFinite),closes=recent.map(x=>finite(x.close)).filter(Number.isFinite);if(lows.length<3||highs.length<3)return null;return{support:Math.min(...lows),resistance:Math.max(...highs),from:closes[0],to:closes.at(-1),count:recent.length}};
  const polyline=(series,range,w,h)=>{if(series.length<2)return'';const pts=series.map((v,i)=>{if(!Number.isFinite(v))return null;const x=i/(series.length-1)*w,y=lineY(v,range,h);return`${x.toFixed(1)},${y.toFixed(1)}`}).filter(Boolean);return pts.length>1?pts.join(' '):''};
  const ema=(values,period)=>{if(values.length<period)return[];const k=2/(period+1),out=Array(values.length).fill(null);let seed=values.slice(0,period).reduce((a,b)=>a+b,0)/period;out[period-1]=seed;for(let i=period;i<values.length;i++){seed=values[i]*k+seed*(1-k);out[i]=seed}return out};

  async function render(){
    const {scannerState={},settings={}}=await chrome.storage.local.get(['scannerState','settings']).catch(()=>({}));
    const features=settings.features||{},enabled=features.chartLines!==false&&(features.supportResistance!==false||features.emaOverlay!==false||features.trendLine!==false);
    const target=chartTarget(),root=ensure();if(!enabled||!target||scannerState.connection!=='online'){root.style.display='none';return}
    const asset=String(scannerState.asset||''),hist=scannerState.marketHistory||scannerState.diagnostics?.network?.recentCandles||{};
    let rows=[];for(const[k,v]of Object.entries(hist||{})){if(String(k).replace(/\s*\(OTC\)$/i,'')===asset.replace(/\s*\(OTC\)$/i,'')){rows=Array.isArray(v)?v.slice(-60):[];break}}
    if(rows.length<3){root.style.display='none';return}
    const recent=shortFromRows(rows),techShort=scannerState.signal?.technical?.shortTerm||scannerState.signal?.recentAnalysis||{},short={...recent,...techShort};
    if(!short||!Number.isFinite(Number(short.support))||!Number.isFinite(Number(short.resistance))){root.style.display='none';return}
    const r=target.r;Object.assign(root.style,{display:'block',left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`});
    const all=rows.slice(-20).flatMap(c=>[finite(c.low),finite(c.high)]).filter(Number.isFinite),min=Math.min(...all),max=Math.max(...all),pad=(max-min)*.06||1,range={min:min-pad,max:max+pad},w=Math.max(1,r.width),h=Math.max(1,r.height);
    const support=Number(short.support),resistance=Number(short.resistance),zone=Math.max((resistance-support)*.018,(max-min)*.006,1e-9),key=`${asset}|${rows.at(-1)?.time}|${support}|${resistance}|${Math.round(r.width)}|${Math.round(r.height)}|${JSON.stringify(features)}`;if(key===lastKey)return;lastKey=key;
    const pieces=['<defs><filter id="atsGlow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'];
    if(features.supportResistance!==false){
      const sy1=lineY(support+zone,range,h),sy2=lineY(support-zone,range,h),ry1=lineY(resistance+zone,range,h),ry2=lineY(resistance-zone,range,h);
      pieces.push(`<rect x="0" y="${Math.min(sy1,sy2)}" width="${w}" height="${Math.abs(sy2-sy1)}" fill="rgba(79,224,165,.10)" stroke="rgba(79,224,165,.65)" stroke-width="1"/>`);
      pieces.push(`<text x="10" y="${Math.max(13,lineY(support,range,h)-6)}" fill="#86efc5" font-size="10" font-weight="700">SUPORTE • últimas ${short.count||Math.min(5,rows.length)} velas</text>`);
      pieces.push(`<rect x="0" y="${Math.min(ry1,ry2)}" width="${w}" height="${Math.abs(ry2-ry1)}" fill="rgba(255,108,134,.09)" stroke="rgba(255,108,134,.62)" stroke-width="1"/>`);
      pieces.push(`<text x="10" y="${Math.max(13,lineY(resistance,range,h)-6)}" fill="#ff9aad" font-size="10" font-weight="700">RESISTÊNCIA • últimas ${short.count||Math.min(5,rows.length)} velas</text>`);
    }
    if(features.trendLine!==false&&Number.isFinite(Number(short.from))&&Number.isFinite(Number(short.to))){const y1=lineY(Number(short.from),range,h),y2=lineY(Number(short.to),range,h);pieces.push(`<line x1="${w*.1}" y1="${y1}" x2="${w*.9}" y2="${y2}" stroke="#f2c661" stroke-width="1.4" stroke-dasharray="8 5" opacity=".82"/><text x="${w*.62}" y="${Math.max(12,y2-7)}" fill="#f6d77f" font-size="9">TENDÊNCIA CURTA</text>`)}
    if(features.emaOverlay!==false&&rows.length>=9){const closes=rows.slice(-30).map(c=>finite(c.close)).filter(Number.isFinite),p9=polyline(ema(closes,9),range,w,h),p21=rows.length>=21?polyline(ema(closes,21),range,w,h):'';if(p9)pieces.push(`<polyline points="${p9}" fill="none" stroke="#5bdcff" stroke-width="1.5" opacity=".80"/>`);if(p21)pieces.push(`<polyline points="${p21}" fill="none" stroke="#a987ff" stroke-width="1.4" opacity=".72"/>`)}
    const svg=root.firstElementChild;svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.innerHTML=pieces.join('');
  }
  const schedule=()=>setTimeout(render,70);chrome.storage.onChanged.addListener(c=>{if(c.scannerState||c.settings)schedule()});window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true});render();setInterval(render,1200);
})();
