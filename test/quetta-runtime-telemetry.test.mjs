import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('0.11.13 keeps runtime injection and boot telemetry without exposing page secrets', () => {
  const manifest = JSON.parse(read('manifest.json')); const entry = read('src/background-entry.js'); const telemetry = read('src/background-runtime-telemetry.js'); const boot = read('src/content/runtime-boot-probe.js'); const diagnostics = read('src/sidepanel/diagnostics-export.js');
  assert.match(manifest.version, /^0\.11\.\d+$/); assert.match(entry, /background-runtime-telemetry\.js/); assert.match(telemetry, /ATS_RUNTIME_BOOT/); assert.match(telemetry, /runtimeBoot/); assert.match(telemetry, /frameHints/); assert.match(telemetry, /casaHost\(topHost\(sender\)\)/); assert.match(boot, /settled-1200/); assert.match(boot, /settled-3500/); assert.match(boot, /iframe/); assert.match(diagnostics, /runtimeInjection/); assert.match(diagnostics, /runtimeBoot/); assert.match(diagnostics, /safeProbeFrames/); assert.match(diagnostics, /safeBootRows/); assert.doesNotMatch(diagnostics, /licenseKey|authorization|cookie|bearer|apiKey/i);
});
test('runtime diagnostics expose host and protocol only for frame topology', () => { const telemetry=read('src/background-runtime-telemetry.js'); const boot=read('src/content/runtime-boot-probe.js'); assert.match(telemetry,/protocol: clean/); assert.match(telemetry,/host: clean/); assert.match(boot,/hostname/); assert.doesNotMatch(telemetry,/searchParams|pathname|href/); assert.doesNotMatch(boot,/searchParams|pathname/); });
