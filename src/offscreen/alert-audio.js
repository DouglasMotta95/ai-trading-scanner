let audioContext = null;

function tone(frequency, delay, duration, gain) {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const amplifier = audioContext.createGain();
  const start = audioContext.currentTime + delay;

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  amplifier.gain.setValueAtTime(0.0001, start);
  amplifier.gain.exponentialRampToValueAtTime(gain, start + 0.018);
  amplifier.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(amplifier);
  amplifier.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

async function play(kind) {
  audioContext ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  if (audioContext.state === 'suspended') await audioContext.resume().catch(() => {});

  if (kind === 'pre') {
    tone(650, 0, 0.13, 0.08);
    tone(820, 0.15, 0.12, 0.075);
    return;
  }

  tone(760, 0, 0.16, 0.10);
  tone(980, 0.16, 0.18, 0.11);
  tone(1180, 0.32, 0.20, 0.12);
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'ATS_PLAY_ALERT_SOUND') return false;
  play(message.kind === 'pre' ? 'pre' : 'final').catch(() => {});
  return false;
});
