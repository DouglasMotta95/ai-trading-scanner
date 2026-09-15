const $ = id => document.getElementById(id);

function tone(status = '') {
  if (status === 'GOOD') return 'good';
  if (status === 'POOR') return 'bad';
  if (status === 'WATCH') return 'warn';
  return 'waiting';
}

function render(snapshot = {}) {
  const list = $('assetRadarList');
  if (!list) return;
  // The opened asset already has one authoritative quality card above. Showing it
  // again here used a reduced radar context and could contradict that card.
  const rows = (Array.isArray(snapshot.rows) ? snapshot.rows : []).filter(row => row?.focused !== true);
  if ($('assetRadarBadge')) {
    $('assetRadarBadge').textContent = rows.length ? `${rows.length} OUTROS` : 'COLETANDO';
    $('assetRadarBadge').className = `badge ${rows.some(row => row.status === 'GOOD') ? 'ok' : 'warn'}`;
  }
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'radar-empty';
    empty.textContent = 'Ainda não há outros ativos observados com histórico suficiente. O ativo aberto é avaliado somente no card acima.';
    list.appendChild(empty);
    return;
  }
  for (const row of rows.slice(0, 6)) {
    const item = document.createElement('div');
    item.className = `radar-row ${tone(row.status)}`;
    const main = document.createElement('div');
    main.className = 'radar-main';
    const title = document.createElement('b');
    title.textContent = row.asset || '—';
    const sub = document.createElement('span');
    sub.textContent = row.context || row.label || 'OBSERVADO';
    main.append(title, sub);
    const score = document.createElement('div');
    score.className = 'radar-score';
    score.innerHTML = `<b>${row.score == null ? '—' : row.score}</b><span>${row.score == null ? 'coletando' : '/100'}</span>`;
    const action = document.createElement('div');
    action.className = 'radar-action';
    action.textContent = row.score == null ? 'ABRA PARA CONFIRMAR' : row.label || 'OBSERVAR';
    item.append(main, score, action);
    list.appendChild(item);
  }
  if ($('assetRadarNote')) $('assetRadarNote').textContent = 'O ativo aberto usa a avaliação principal acima. Aqui aparecem somente outros mercados observados.';
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_GET_ASSET_RADAR' }).catch(() => null);
  if (response?.ok) render(response.snapshot || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.atsAssetRadarV1) render(changes.atsAssetRadarV1.newValue || {});
});

refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), 3000);
