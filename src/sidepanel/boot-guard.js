(() => {
  if (globalThis.__ATS_BOOT_GUARD__) return;
  globalThis.__ATS_BOOT_GUARD__ = true;

  const show = message => {
    try {
      const box = document.getElementById('bootError');
      const text = document.getElementById('bootErrorText');
      if (text && message) text.textContent = String(message);
      if (box) {
        box.hidden = false;
        box.style.setProperty('display', 'block', 'important');
        box.style.setProperty('visibility', 'visible', 'important');
        box.style.setProperty('opacity', '1', 'important');
      }
      document.documentElement.classList.add('ats-ui-recovery');
      document.documentElement.style.backgroundColor = '#08111d';
      document.body.style.backgroundColor = '#08111d';
      document.body.style.color = '#e5eef7';
      document.body.style.visibility = 'visible';
      document.body.style.opacity = '1';
      if (!document.querySelector('#decisionBanner, main, .app-shell') || !String(document.body.innerText || '').trim()) {
        let fallback = document.getElementById('atsPanelEmergencyFallback');
        if (!fallback) {
          fallback = document.createElement('section');
          fallback.id = 'atsPanelEmergencyFallback';
          fallback.setAttribute('role', 'alert');
          fallback.style.cssText = 'position:fixed;z-index:2147483647;inset:12px 10px auto;padding:16px;border:1px solid #32506a;border-radius:14px;background:#08111d;color:#e5eef7;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 36px #0009';
          const heading = document.createElement('strong');
          heading.textContent = 'AI TRADING SCANNER — RECUPERAÇÃO DO PAINEL';
          const detail = document.createElement('p');
          detail.id = 'atsPanelEmergencyDetail';
          detail.style.cssText = 'margin:8px 0;color:#b7cad9;overflow-wrap:anywhere';
          const hint = document.createElement('small');
          hint.textContent = 'Último estado e licença permanecem salvos. O scanner não executa operações automaticamente.';
          fallback.append(heading, detail, hint);
          (document.body || document.documentElement).appendChild(fallback);
          try {
            chrome.storage?.local?.get?.(['scannerState'], data => {
              const saved = data?.scannerState || {};
              const signal = saved.signal || {};
              const clock = saved.diagnostics?.marketClock || {};
              const license = String(saved.license?.status || 'desconhecida').toUpperCase();
              const score = Number(signal.analysisScore ?? signal.score ?? saved.professionalDecision?.score ?? 0);
              const remaining = clock.secondsRemaining == null ? 'sem countdown salvo' : `${Math.max(0, Math.ceil(Number(clock.secondsRemaining)))}s`;
              const target = document.getElementById('atsPanelEmergencyDetail');
              if (target) target.textContent = `Licença: ${license} • Ativo: ${saved.asset || 'identificando'} • Score salvo: ${Math.round(score)}/100 • Countdown observado: ${remaining}. Erro: ${String(message || 'renderização interrompida')}`;
            });
          } catch {}
        } else {
          const detail = fallback.querySelector('#atsPanelEmergencyDetail');
          if (detail) detail.textContent = String(message || 'Falha de renderização; painel em recuperação.');
        }
      }
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
