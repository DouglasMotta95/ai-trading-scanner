const atsBankrollNum = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const ATS_BANKROLL_READ_GRACE_MS = 6000;
const atsBankrollStartedAt = Date.now();

function atsBankrollStyle() {
  if (document.querySelector('link[data-ats-bankroll-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('src/sidepanel/bankroll.css');
  link.dataset.atsBankrollStyle = '1';
  document.head.appendChild(link);
}

function atsBankrollCard() {
  let card = document.getElementById('bankrollCard');
  if (card) return card;
  const anchor = document.querySelector('.validation-card') || document.querySelector('.preferences-card');
  if (!anchor?.parentElement) return null;
  card = document.createElement('section');
  card.id = 'bankrollCard';
  card.className = 'card bankroll-card waiting';
  card.innerHTML = `
    <div class="section-head">
      <div><span class="eyebrow">BANCA / CONTROLE</span><h2 id="bankrollTitle">Lendo conta da CasaTrade</h2></div>
      <span id="bankrollBadge" class="badge warn">LENDO</span>
    </div>
    <div class="bankroll-grid">
      <div><span>SALDO</span><b id="bankrollBalance">—</b></div>
      <div><span>VALOR ENTRADA</span><b id="bankrollStake">—</b></div>
      <div><span>ENTRADA / BANCA</span><b id="bankrollRisk">—</b></div>
      <div><span>VARIAÇÃO SESSÃO</span><b id="bankrollDelta">—</b></div>
      <div><span>PAYOUT OBSERVADO</span><b id="bankrollPayout">—</b></div>
      <div><span>SEQUÊNCIA REAL</span><b id="bankrollStreak">—</b></div>
    </div>
    <p id="bankrollNote" class="muted">Leitura passiva. A extensão não altera saldo nem valor da entrada.</p>`;
  anchor.insertAdjacentElement('beforebegin', card);
  return card;
}

function atsFormatMoney(value, currency) {
  const n = atsBankrollNum(value);
  if (n == null) return '—';
  const code = ['BRL','USD','EUR','GBP'].includes(String(currency || '').toUpperCase()) ? String(currency).toUpperCase() : null;
  if (!code) return String(n);
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(n); }
  catch { return String(n); }
}

function atsStreak(rows = []) {
  const resolved = (Array.isArray(rows) ? rows : []).filter(row => row?.matchedSignal === true && row?.status === 'RESOLVED' && ['WIN','LOSS'].includes(String(row.result || '').toUpperCase()));
  if (!resolved.length) return '—';
  const last = String(resolved.at(-1).result).toUpperCase();
  let count = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (String(resolved[i].result || '').toUpperCase() !== last) break;
    count++;
  }
  return `${count} ${last}`;
}

async function atsBankrollRender(state = {}) {
  atsBankrollStyle();
  const card = atsBankrollCard();
  if (!card) return;
  const data = state.accountMetrics || {};
  const now = Date.now();
  const balanceFresh = atsBankrollNum(data.balance) != null && now - Number(data.balanceAt || data.observedAt || 0) < 12000;
  const stakeFresh = atsBankrollNum(data.stake) != null && now - Number(data.stakeAt || data.observedAt || 0) < 12000;
  const payoutFresh = atsBankrollNum(data.payoutPct) != null && now - Number(data.payoutAt || data.observedAt || 0) < 12000;
  const anyFresh = balanceFresh || stakeFresh;
  const readFinished = anyFresh || now - atsBankrollStartedAt >= ATS_BANKROLL_READ_GRACE_MS;
  const unavailable = !anyFresh && readFinished;
  const ledger = await chrome.runtime.sendMessage({ type: 'ATS_GET_MANUAL_TRADE_LEDGER' }).catch(() => null);
  const rows = ledger?.ok ? ledger.rows || [] : [];

  card.className = `card bankroll-card ${anyFresh ? 'live' : unavailable ? 'unavailable' : 'waiting'}`;
  const badge = document.getElementById('bankrollBadge');
  if (badge) {
    badge.textContent = anyFresh ? 'AO VIVO' : unavailable ? 'NÃO DISPONÍVEL' : 'LENDO';
    badge.className = `badge ${anyFresh ? 'ok' : 'warn'}`;
  }
  const title = document.getElementById('bankrollTitle');
  if (title) title.textContent = anyFresh ? 'Controle da sessão' : unavailable ? 'Dados bancários não disponíveis' : 'Lendo conta da CasaTrade';
  const missing = unavailable ? 'NÃO DISPONÍVEL' : '—';
  const balance = document.getElementById('bankrollBalance'); if (balance) balance.textContent = balanceFresh ? atsFormatMoney(data.balance, data.currency) : missing;
  const stake = document.getElementById('bankrollStake'); if (stake) stake.textContent = stakeFresh ? atsFormatMoney(data.stake, data.currency) : missing;
  const risk = document.getElementById('bankrollRisk'); if (risk) risk.textContent = balanceFresh && stakeFresh && atsBankrollNum(data.riskPct) != null ? `${Number(data.riskPct).toFixed(2)}%` : missing;
  const delta = document.getElementById('bankrollDelta');
  if (delta) {
    const value = balanceFresh ? atsBankrollNum(data.sessionDelta) : null;
    delta.textContent = value == null ? missing : `${value > 0 ? '+' : ''}${atsFormatMoney(value, data.currency)}`;
    delta.classList.toggle('positive', value != null && value > 0);
    delta.classList.toggle('negative', value != null && value < 0);
  }
  const payout = document.getElementById('bankrollPayout'); if (payout) payout.textContent = payoutFresh ? `${Number(data.payoutPct).toFixed(1)}%` : missing;
  const streak = document.getElementById('bankrollStreak'); if (streak) streak.textContent = atsStreak(rows);
  const note = document.getElementById('bankrollNote');
  if (note) note.textContent = anyFresh
    ? 'Saldo e valor vêm da interface da CasaTrade; entrada/banca é apenas a relação matemática entre os dois. A extensão não altera esses valores.'
    : unavailable
      ? 'A CasaTrade não expôs saldo/valor com segurança nesta leitura. Estado encerrado como NÃO DISPONÍVEL; a extensão não fica em busca infinita.'
      : 'Tentando localizar saldo e valor apenas por rótulos confiáveis da CasaTrade.';
}

async function atsBankrollRefresh() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  if (response?.state) atsBankrollRender(response.state).catch(() => {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) atsBankrollRender(changes.scannerState.newValue || {}).catch(() => {});
  if (changes.atsManualTradeLedgerV1) atsBankrollRefresh().catch(() => {});
});

atsBankrollStyle();
atsBankrollCard();
atsBankrollRefresh().catch(() => {});
setInterval(() => atsBankrollRefresh().catch(() => {}), 3000);
