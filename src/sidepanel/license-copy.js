(() => {
  const text = document.getElementById('licenseText');
  if (!text) return;

  const clean = () => {
    const t = text.textContent || '';
    if (/fale com o atendimento/i.test(t)) {
      text.textContent = t.replace(/\s*fale com o atendimento\.?/gi, '').trim();
    }
    const footerVersion = document.querySelector('footer span:last-child');
    if (footerVersion) footerVersion.textContent = `v${chrome.runtime.getManifest().version} • LIVE OPS`;
  };

  clean();
  new MutationObserver(clean).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden']
  });
  setInterval(clean, 1000);

  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('src/sidepanel/account-login.js');
  document.body.appendChild(s);
})();
