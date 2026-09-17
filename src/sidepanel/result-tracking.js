(() => {
  const HISTORY_KEY = 'atsSignalResultHistory';
  const MAX_HISTORY = 500;
  const $ = id => document.getElementById(id);

  const dayKey = value => {
    const d = new Date(value || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const signalKey = signal => [
    signal?.asset || '', signal?.direction || '', signal?.targetAt || signal?.at || signal?.confirmedAt || ''
  ].join('|');

  async function readHistory() {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  }

  async function writeHistory(rows) {
    await chrome.storage.local.set({ [HISTORY_KEY]: rows.slice(0, MAX_HISTORY) });
  }

  function render(rows) {
    const today = dayKey();
    const todays = rows.filter(row => dayKey(row.confirmedAt || row.at) === today);
    const resolved = todays.filter(row => row.result === 'win' || row.result === 'loss');
    const wins = resolved.filter(row => row.result === 'win').length;
    const accuracy = resolved.length ? `${Math.round((wins / resolved.length) * 100)}%` : '—';
    if ($('signalStats')) $('signalStats').textContent = `Sinais hoje: ${todays.length} • Acerto: ${accuracy}`;

    const latest = rows[0];
    const canMark = latest && !latest.result;
    if ($('markWin')) $('markWin').disabled = !canMark;
    if ($('markLoss')) $('markLoss').disabled = !canMark;
    if ($('resultStatus')) {
      $('resultStatus').textContent = !latest ? 'Nenhum sinal confirmado para marcar.'
        : latest.result === 'win' ? 'Último sinal marcado: GANHEI'
          : latest.result === 'loss' ? 'Último sinal marcado: PERDI'
            : 'Marque o resultado do último sinal confirmado.';
    }
  }

  async function captureLatestConfirmed() {
    const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
    const state = response?.state || response || {};
    const confirmed = state.lastConfirmed;
    if (!confirmed || !confirmed.direction) return;

    const row = {
      id: signalKey({ ...confirmed, asset: confirmed.asset || state.asset }),
      asset: confirmed.asset || state.asset || '—',
      direction: confirmed.direction,
      confirmedAt: Number(confirmed.at || confirmed.confirmedAt || Date.now()),
      targetAt: confirmed.targetAt || null,
      result: null
    };
    const rows = await readHistory();
    if (!rows.some(item => item.id === row.id)) {
      rows.unshift(row);
      await writeHistory(rows);
      render(rows);
    }
  }

  async function mark(result) {
    const rows = await readHistory();
    if (!rows.length || rows[0].result) return render(rows);
    rows[0] = { ...rows[0], result, resolvedAt: Date.now(), resolution: 'manual' };
    await writeHistory(rows);
    render(rows);
  }

  $('markWin')?.addEventListener('click', () => mark('win'));
  $('markLoss')?.addEventListener('click', () => mark('loss'));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HISTORY_KEY]) render(changes[HISTORY_KEY].newValue || []);
  });

  readHistory().then(render).catch(() => {});
  captureLatestConfirmed().catch(() => {});
  setInterval(() => captureLatestConfirmed().catch(() => {}), 1000);
})();
