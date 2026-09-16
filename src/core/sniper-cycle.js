import { timeframeSeconds } from './market-normalizers.js';

export function sniperWindows(timeframe = 'M1') {
  const duration = Math.max(2,timeframeSeconds(timeframe));
  if (duration === 60) return { duration, prepareAt: 30, executeAt: 10 };
  const prepareAt = Math.max(2,Math.min(duration-1,Math.round(duration*0.5)));
  const executeAt = Math.max(1,Math.min(prepareAt-1,Math.round(duration/6)));
  return { duration, prepareAt, executeAt };
}
export function sniperPhase(secondsRemaining, timeframe = 'M1') {
  const s = Math.max(0,Number(secondsRemaining)||0);
  const windows = sniperWindows(timeframe);
  if (s > windows.prepareAt) return { phase:'OBSERVE', ...windows };
  if (s > windows.executeAt) return { phase:'PREPARE', ...windows };
  return { phase:'EXECUTE', ...windows };
}
