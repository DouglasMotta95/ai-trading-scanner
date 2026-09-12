import { weightedConfidence, AI_WEIGHTS, AI_THRESHOLDS } from '../core/ai-scoring.js';

export { AI_WEIGHTS, AI_THRESHOLDS };

const timeoutFetch=async(url,options={},timeoutMs=5000)=>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal})}finally{clearTimeout(timer)}
};

export class AIProvider{
  constructor({baseUrl='',enabled=false,timeoutMs=5000}={}){
    this.baseUrl=String(baseUrl||'').replace(/\/$/,'');
    this.enabled=!!enabled;
    this.timeoutMs=Math.max(1500,Number(timeoutMs)||5000);
  }

  localReview(candidate={}){
    return {available:true,source:'weighted-local',...weightedConfidence(candidate)};
  }

  async review(candidate={}){
    const local=this.localReview(candidate);
    if(!this.enabled||!this.baseUrl)return{...local,remote:{available:false,reason:'IA externa não configurada'}};
    try{
      const r=await timeoutFetch(`${this.baseUrl}/v1/ai/review`,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({candidate,local})
      },this.timeoutMs);
      if(!r.ok)throw new Error(`provider_${r.status}`);
      const remote=await r.json();
      return{...local,remote:{available:true,...remote},source:'weighted-local+remote'};
    }catch(e){
      return{...local,remote:{available:false,reason:e?.name==='AbortError'?'timeout':'indisponível'},source:'weighted-local'};
    }
  }
}
