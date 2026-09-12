(()=>{
  if(globalThis.__ATS_CHART_OVERLAY__)return;globalThis.__ATS_CHART_OVERLAY__=true;
  let overlay=null,lastKey='';
  const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>220&&r.height>140&&s.display!=='none'&&s.visibility!=='hidden'};
  const chartTarget=()=>{
    const nodes=[...document.querySelectorAll('canvas,svg,[class*="chart" i],[id*="chart" i]')].filter(visible).map(el=>({el,r:el.getBoundingClientRect()})).filter(x=>x.r.width*x.r.height>50000).sort((a,b)=>b.r.width*b.r.height-a.r.width*a.r.height);
    return nodes[0]||null;
  };
  const closes=rows=>rows.map(c=>Number(c?.close)).filter(Number.isFinite);
  const ema=(values,period)=>{if(values.length<period)return[];const k=2/(period+1),out=Array(values.length).fill(null);let seed=values.slice(0,period).reduce((a,b)=>a+b,0)/period;out[period-1]=seed;for(let i=period;i<values.length;i++){seed=values[i]*k+seed*(1-k);out[i]=seed}return out};
  const pathFor=(series,range,w,h)=>{const pts=[];const valid=series.map((v,i)=>[i,Number(v)]).filter(([,v])=>Number.isFinite(v));if(valid.length<2)return'';const n=series.length-1||1;for(const[i,v]of valid){const x=i/n*w,y=h-(v-range.min)/(range.max-range.min||1)*h;pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)}return pts.join(' ')};
  const lineY=(v,range,h)=>h-(v-range.min)/(range.max-range.min||1)*h;
  const ensure=()=>{if(overlay?.isConnected)return overlay;overlay=document.createElement('div');overlay.id='ats-chart-overlay';Object.assign(overlay.style,{position:'fixed',zIndex:'2147483000',pointerEvents:'none',display:'none',overflow:'hidden',borderRadius:'8px'});overlay.innerHTML='<svg width="100%" height="100%" preserveAspectRatio="none"></svg>';document.documentElement.appendChild(overlay);return overlay};
  async function render(){
    const {scannerState={},settings={}}=await chrome.storage.local.get(['scannerState','settings']).catch(()=>({}));
    const features=settings.features||{},enabled=features.chartLines!==false&&(features.supportResistance!==false||features.emaOverlay!==false||features.trendLine!==false);
    const target=chartTarget(),root=ensure();if(!enabled||!target||scannerState.connection!=='online'){root.style.display='none';return}
    const asset=String(scannerState.asset||''),hist=scannerState.marketHistory||scannerState.diagnostics?.network?.recentCandles||{};
    let rows=[];for(const[k,v]of Object.entries(hist||{})){if(String(k).replace(/\s*\(OTC\)$/i,'')===asset.replace(/\s*\(OTC\)$/i,'')){rows=Array.isArray(v)?v.slice(-60):[];break}}
    if(rows.length<5){root.style.display='none';return}
    const r=target.r;Object.assign(root.style,{display:'block',left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`});
    const all=rows.flatMap(c=>[Number(c.low),Number(c.high)]).filter(Number.isFinite),min=Math.min(...all),max=Math.max(...all),pad=(max-min)*.05||1,range={min:min-pad,max:max+pad},w=Math.max(1,r.width),h=Math.max(1,r.height),vals=closes(rows),e9=ema(vals,9),e21=ema(vals,21);
    const tech=scannerState.signal?.technical||{},structure=tech.structure||{},support=Number(structure.support),resistance=Number(structure.resistance),first=Number(vals[0]),last=Number(vals.at(-1));
    const key=`${asset}|${rows.at(-1)?.time}|${Math.round(r.width)}|${Math.round(r.height)}|${JSON.stringify(features)}`;if(key===lastKey)return;lastKey=key;
    const svg=root.firstElementChild;const pieces=[];
    pieces.push('<defs><filter id="atsGlow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>');
    if(features.supportResistance!==false&&Number.isFinite(support)){const y=lineY(support,range,h);pieces.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#4fe0a5" stroke-width="1.3" stroke-dasharray="7 6" opacity=".85"/><text x="8" y="${Math.max(12,y-5)}" fill="#86efc5" font-size="10">SUPORTE ${support}</text>`)}
    if(features.supportResistance!==false&&Number.isFinite(resistance)){const y=lineY(resistance,range,h);pieces.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#ff6d86" stroke-width="1.3" stroke-dasharray="7 6" opacity=".85"/><text x="8" y="${Math.max(12,y-5)}" fill="#ff9aad" font-size="10">RESISTÊNCIA ${resistance}</text>`)}
    if(features.emaOverlay!==false){const p9=pathFor(e9,range,w,h),p21=pathFor(e21,range,w,h);if(p9)pieces.push(`<polyline points="${p9}" fill="none" stroke="#5bdcff" stroke-width="1.8" opacity=".9" filter="url(#atsGlow)"/>`);if(p21)pieces.push(`<polyline points="${p21}" fill="none" stroke="#a987ff" stroke-width="1.7" opacity=".85"/>`)}
    if(features.trendLine!==false&&Number.isFinite(first)&&Number.isFinite(last)){const y1=lineY(first,range,h),y2=lineY(last,range,h);pieces.push(`<line x1="0" y1="${y1}" x2="${w}" y2="${y2}" stroke="#f2c661" stroke-width="1.2" opacity=".72"/>`)}
    svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.innerHTML=pieces.join('');
  }
  const schedule=()=>setTimeout(render,80);chrome.storage.onChanged.addListener(c=>{if(c.scannerState||c.settings)schedule()});window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true});render();setInterval(render,1500);
})();
