(() => {
  if(globalThis.__ATS_SNIPER_PAGE_BOOTSTRAP__)return;globalThis.__ATS_SNIPER_PAGE_BOOTSTRAP__=true;
  const files=['src/content/page-world-sentinel.js','src/content/standalone-instrument-probe.js','src/content/worker-probe.js','src/content/network-probe.js'];const runtime=globalThis.chrome?.runtime;
  function mount(){const root=document.documentElement||document.head||document.body;if(!root||!runtime?.getURL){setTimeout(mount,50);return}for(const file of files){const key=`ats-sniper-${file.split('/').pop()}`;if(document.querySelector(`script[data-ats-sniper-file="${key}"]`))continue;try{const s=document.createElement('script');s.src=runtime.getURL(file);s.async=false;s.dataset.atsSniperFile=key;root.appendChild(s)}catch{}}}
  mount();
})();
