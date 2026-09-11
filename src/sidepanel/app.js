const $ = id => document.getElementById(id);
const connectBtn = $('connectBtn');
let requested = false;

function render(state = {}) {
  const online = state.connection === 'online' && state.lastSeen && Date.now() - state.lastSeen < 7000;
  $('liveBadge').className = `live-badge ${online ? 'online' : 'offline'}`;
  $('liveBadge').querySelector('span').textContent = online ? 'ONLINE' : 'OFFLINE';
  $('connectionOrb').classList.toggle('connected', online);
  $('platformPill').className = `pill ${online ? 'online' : ''}`;
  $('platformPill').textContent = online ? 'CASATRADE CONECTADA' : 'AGUARDANDO';
  $('feedHealth').textContent = online ? 'ONLINE' : 'OFFLINE';
  $('feedHealth').previousElementSibling?.classList.toggle('online', online);
  $('asset').textContent = state.asset || '—';
  $('timeframe').textContent = state.timeframe || '—';
  $('price').textContent = state.price || '—';
  $('marketStatus').textContent = online ? 'RECEBENDO' : 'SEM DADOS';
  $('latency').textContent = online ? '< 3s' : '—';

  if (online) {
    $('connectionTitle').textContent = 'CasaTrade conectada';
    $('connectionText').textContent = 'A extensão está enxergando a plataforma. O diagnóstico de mercado está ativo.';
    connectBtn.classList.remove('connecting');
    $('connectLabel').textContent = state.scanner === 'scanning' ? 'PAUSAR SCANNER' : 'ATIVAR SCANNER';
    $('scannerState').textContent = state.scanner === 'scanning' ? 'PROCURANDO OPORTUNIDADES' : 'SCANNER PRONTO';
    $('scannerHint').textContent = state.scanner === 'scanning' ? 'Monitorando alterações da plataforma em tempo real.' : 'Ative para iniciar a análise contínua.';
  } else if (requested) {
    connectBtn.classList.add('connecting');
    $('connectLabel').textContent = 'PROCURANDO CASATRADE...';
    $('connectionTitle').textContent = 'Conectando à plataforma';
    $('connectionText').textContent = 'Mantenha a CasaTrade aberta em outra aba enquanto localizamos o terminal.';
  }
}

async function getState() {
  try { render(await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' })); } catch { render({}); }
}

connectBtn.addEventListener('click', async () => {
  const state = await chrome.runtime.sendMessage({ type: 'ATS_GET_STATE' });
  const online = state?.connection === 'online' && state?.lastSeen && Date.now() - state.lastSeen < 7000;
  if (!online) {
    requested = true;
    render(state);
    const tabs = await chrome.tabs.query({ url: ['https://*.casatrade.com/*','https://*.casatrade.io/*'] });
    if (!tabs.length) {
      $('connectionTitle').textContent = 'CasaTrade não encontrada';
      $('connectionText').textContent = 'Abra a plataforma CasaTrade em uma aba e tente novamente.';
      connectBtn.classList.remove('connecting');
      $('connectLabel').textContent = 'TENTAR NOVAMENTE';
      return;
    }
    setTimeout(getState, 700);
    return;
  }
  await chrome.runtime.sendMessage({ type: 'ATS_SET_SCANNER', enabled: state.scanner !== 'scanning' });
  getState();
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) render(changes.scannerState.newValue);
});
getState();
setInterval(getState, 2500);
