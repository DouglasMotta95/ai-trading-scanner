(() => {
  if (globalThis.__ATS_BOOT_GUARD__) return;
  globalThis.__ATS_BOOT_GUARD__ = true;

  const show = message => {
    try {
      const box = document.getElementById('bootError');
      const text = document.getElementById('bootErrorText');
      if (text && message) text.textContent = String(message);
      if (box) box.hidden = false;
      document.documentElement.classList.add('ats-ui-recovery');
      document.body.style.visibility = 'visible';
      document.body.style.opacity = '1';
    } catch {}
  };

  globalThis.__ATS_MARK_UI_READY__ = () => {
    try {
      document.documentElement.dataset.atsUiReady = '1';
      const box = document.getElementById('bootError');
      if (box) box.hidden = true;
    } catch {}
  };

  window.addEventListener('error', event => {
    show(`Erro no painel: ${event?.message || 'falha de inicialização'}`);
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event?.reason?.message || event?.reason || 'falha assíncrona';
    show(`Erro no painel: ${reason}`);
  });

  setTimeout(() => {
    if (document.documentElement.dataset.atsUiReady !== '1') {
      show('O painel não concluiu a inicialização. Reabra a extensão ou copie o diagnóstico.');
    }
  }, 3500);
})();
