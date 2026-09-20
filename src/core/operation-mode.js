const clean = value => String(value ?? '').trim().toUpperCase();

export function operatingTimeframeFromPreferences(preferences = {}) {
  return clean(preferences?.operatingTimeframe) === 'M5' ? 'M5' : 'M1';
}
