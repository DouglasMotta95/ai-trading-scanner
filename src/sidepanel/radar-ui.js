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
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  if ($('assetRadarBadge')) {
    $('assetRadarBadge').textContent = rows.length ? `${rows.length} OBSERVADOS` : 'COLETANDO';
    $('assetRadarBadge').className = `badge ${rows.some(row => row.status === 'GOOD') ? 'ok' : 'warn'}`;
  }
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'radar-empty';
    empty.textContent = 'Abra ou deixe a CasaTrade carregar ativos para o radar começar a comparar os mercados observados.';
    list.appendChild(empty);
    return;
  }
  for (const row of rows.slice(0, 6)) {
    const item = document.createElement('div');
    item.className = `radar-row ${tone(row.status)}${row.focused ? ' focused' : ''}`;
    const main = document.createElement('div');
    main.className = 'radar-main';
    const title = document.createElement('b');
    title.textContent = row.asset || '—';
    const sub = document.createElement('span');
    sub.textContent = row.focused ? 'ABERTO AGORA' : (row.context || row.label || 'OBSERVADO');
    main.append(title, sub);
    const score = document.createElement('div');
    score.className = 'radar-score';
    score.innerHTML = `<b>${row.score == null ? '—' : row.score}</b><span>${row.score == null ? 'coletando' : '/100'}</span>`;
    const action = document.createElement('div');
    action.className = 'radar-action';
    action.textContent = row.focused ? (row.action || 'ANALISANDO') : (row.score == null ? 'ABRA PARA CONFIRMAR' : row.label || 'OBSERVAR');
    item.append(main, score, action);
    list.appendChild(item);
  }
  if ($('assetRadarNote')) $('assetRadarNote').textContent = snapshot.note || 'O radar compara mercados observados; somente o ativo aberto pode gerar entrada.';
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
