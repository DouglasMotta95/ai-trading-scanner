export const SIGNAL_STATES = Object.freeze({
  IDLE:'IDLE', SEARCHING:'SEARCHING', WATCH:'WATCH', WAIT:'WAIT', CONFIRM:'CONFIRM', CANCEL:'CANCEL', NO_TRADE:'NO_TRADE'
});

export function nextSignalState(current, analysis, context = {}) {
  if (!context.connected) return { state:SIGNAL_STATES.IDLE, label:'DESCONECTADO' };
  if (!context.scanning) return { state:SIGNAL_STATES.WAIT, label:'SCANNER PRONTO' };
  if (context.stale) return { state:SIGNAL_STATES.NO_TRADE, label:'FEED DESATUALIZADO' };
  if (!analysis) return { state:SIGNAL_STATES.SEARCHING, label:'PROCURANDO OPORTUNIDADES' };
  if (analysis.state === 'NO_TRADE') return { state:SIGNAL_STATES.NO_TRADE, label:'MERCADO INADEQUADO' };
  if (analysis.score >= 85 && analysis.direction) return { state:SIGNAL_STATES.CONFIRM, label:`${analysis.direction} • CONFIRMAÇÃO FORTE` };
  if (analysis.score >= 70 && analysis.direction) return { state:SIGNAL_STATES.WATCH, label:`${analysis.direction} • SETUP EM FORMAÇÃO` };
  return { state:SIGNAL_STATES.WAIT, label:'AGUARDANDO CONFLUÊNCIA' };
}
