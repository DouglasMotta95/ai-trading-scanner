export function buildDiagnostic(snapshot = {}) {
  const now = Date.now();
  const age = snapshot.lastSeen ? now - snapshot.lastSeen : null;
  const checks = [
    { id:'platform', label:'CasaTrade detectada', ok:snapshot.platform === 'CasaTrade' },
    { id:'heartbeat', label:'Heartbeat recente', ok:age != null && age < 7000 },
    { id:'asset', label:'Ativo identificado', ok:Boolean(snapshot.asset) },
    { id:'timeframe', label:'Timeframe identificado', ok:Boolean(snapshot.timeframe) },
    { id:'price', label:'Preço candidato', ok:Boolean(snapshot.price) },
    { id:'chart', label:'Gráfico candidato', ok:(snapshot.diagnostics?.chartCandidates || 0) > 0 }
  ];
  return {
    timestamp:new Date(now).toISOString(),
    page:snapshot.url || null,
    checks,
    passed:checks.filter(c=>c.ok).length,
    total:checks.length,
    metrics:snapshot.diagnostics || {},
    privacy:'Sem cookies, tokens, senha ou saldo coletados.'
  };
}
