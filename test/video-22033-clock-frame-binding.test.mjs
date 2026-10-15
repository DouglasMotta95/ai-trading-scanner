import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function loadClockBinding(sourcePath) {
  const source = read(sourcePath);
  const start = source.indexOf('function clockFrameBinding(');
  assert.ok(start >= 0, sourcePath + ' must declare clockFrameBinding');
  const match = source.slice(start).match(/\n  }\n/);
  assert.ok(match, sourcePath + ' must close clockFrameBinding');
  const fnSource = source.slice(start, start + match.index + '\n  }'.length);
  const context = { casaHost: host => host === 'casatrade.com' || host.endsWith('.casatrade.com') || host === 'casatrade.io' || host.endsWith('.casatrade.io') };
  vm.runInNewContext(fnSource + '\nglobalThis.binding = clockFrameBinding;', context);
  return context.binding;
}

test('video 22033: same-host top shell is not mistaken for iframe frameId 0', () => {
  const binding = loadClockBinding('src/content/market-cycle-clock-v4.js');
  const frame = binding({ asset:'ETH/USD (OTC)', frameId:7, frameHost:'trade.casatrade.com' }, 'trade.casatrade.com', true);
  assert.equal(frame.sameFocusFrame, false);
  assert.equal(frame.casaControlFrame, true);
  assert.equal(frame.allowed, true);
  assert.equal(frame.crossFrameControl, true);
});

test('direct focused top chart keeps direct binding without cross-frame promotion', () => {
  const binding = loadClockBinding('src/content/market-cycle-clock-v4.js');
  const frame = binding({ asset:'USD/CHF (OTC)', frameId:0, frameHost:'trade.casatrade.com' }, 'trade.casatrade.com', true);
  assert.equal(frame.sameFocusFrame, true);
  assert.equal(frame.crossFrameControl, false);
});

test('nested frame cannot use top-shell cross-frame privilege', () => {
  const binding = loadClockBinding('src/content/market-cycle-clock-v4.js');
  const frame = binding({ asset:'ETH/USD (OTC)', frameId:7, frameHost:'third-party.example' }, 'third-party.example', false);
  assert.equal(frame.allowed, true);
  assert.equal(frame.crossFrameControl, false);
});

test('exact cross-frame clock is reusable only when explicitly bound to focused iframe', () => {
  const source = read('src/content/market-cycle-clock-v4.js');
  assert.match(source, /clock\.crossFrameControl === true[\s\S]*?Number\(clock\.boundFocusFrameId\) === Number\(focus\.frameId\)/);
  assert.match(source, /crossFrameControl: frameBinding\.crossFrameControl/);
  const background = read('src/background-market-session.js');
  assert.match(background, /message\.crossFrameControl === true[\s\S]*?Number\(message\.boundFocusFrameId\) === Number\(focus\.frameId\)/);
});

test('structured feed clock carries explicit focused frame binding', () => {
  const source = read('src/content/embedded-feed-bridge.js');
  assert.match(source, /function clockFrameBinding\(/);
  assert.match(source, /crossFrameControl: frameBinding\.crossFrameControl/);
  assert.match(source, /boundFocusFrameId: Number\(focus\.frameId\)/);
  assert.match(source, /boundFocusFrameHost: String\(focus\.frameHost \|\| ''\)\.toLowerCase\(\)/);
});
