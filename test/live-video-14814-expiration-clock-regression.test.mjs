import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

class FakeElement {
  constructor(tag = 'div', text = '', rect = {}, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.id = attrs.id || '';
    this.className = attrs.class || '';
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.shadowRoot = null;
    this.rect = {
      left: rect.left ?? 0,
      top: rect.top ?? 0,
      width: rect.width ?? 100,
      height: rect.height ?? 24
    };
    this.rect.right = this.rect.left + this.rect.width;
    this.rect.bottom = this.rect.top + this.rect.height;
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  getBoundingClientRect() { return { ...this.rect }; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  matches(selector = '') {
    const role = this.getAttribute('role');
    if (/button/.test(selector) && this.tagName === 'BUTTON') return true;
    if (/input/.test(selector) && this.tagName === 'INPUT') return true;
    if (/select/.test(selector) && this.tagName === 'SELECT') return true;
    if (/\[role="button"\]/.test(selector) && role === 'button') return true;
    if (/\[role="combobox"\]/.test(selector) && role === 'combobox') return true;
    if (/\[aria-haspopup\]/.test(selector) && this.attrs['aria-haspopup']) return true;
    if (/\[data-state\]/.test(selector) && this.attrs['data-state']) return true;
    return false;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }
  querySelectorAll() {
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class FakeInputElement extends FakeElement {
  constructor(value = '', rect = {}, attrs = {}) {
    super('input', '', rect, attrs);
    this.value = value;
  }
}
class FakeSelectElement extends FakeElement {
  constructor(value = '', rect = {}, attrs = {}) {
    super('select', '', rect, attrs);
    this.value = value;
    this.selectedOptions = [{ textContent: value }];
  }
}

function expirationHarness(selectedText) {
  const card = new FakeElement('div', '', { left: 900, top: 80, width: 150, height: 90 }, { class: 'trade-expiration-card' });
  const label = new FakeElement('div', 'Expiração', { left: 915, top: 95, width: 95, height: 20 });
  const selected = new FakeElement('button', selectedText, { left: 915, top: 120, width: 95, height: 28 }, { role: 'button', 'aria-haspopup': 'listbox' });
  card.append(label, selected);

  const menu = new FakeElement('div', '', { left: 700, top: 80, width: 175, height: 340 }, { role: 'listbox' });
  const menuLabel = new FakeElement('div', 'TEMPO DE EXPIRAÇÃO', { left: 715, top: 95, width: 145, height: 22 });
  const options = ['5 seg','10 seg','15 seg','30 seg','45 seg','1 min','2 min','3 min','5 min'].map((value, index) =>
    new FakeElement('div', value, { left: 720, top: 145 + index * 28, width: 120, height: 24 }, {
      role: 'option',
      'aria-selected': value === selectedText ? 'true' : 'false'
    })
  );
  menu.append(menuLabel, ...options);

  const all = [card, label, selected, menu, menuLabel, ...options];
  const documentElement = new FakeElement('html', '', { width: 1200, height: 800 });
  const body = new FakeElement('body',
    `EUR/USD OTC Expiração ${selectedText} TEMPO DE EXPIRAÇÃO 5 seg 10 seg 15 seg 30 seg 45 seg 1 min 2 min 3 min 5 min`,
    { width: 1200, height: 800 }
  );

  const document = {
    documentElement,
    body,
    querySelectorAll() { return all; },
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; }
  };

  const sent = [];
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    console,
    document,
    Element: FakeElement,
    HTMLInputElement: FakeInputElement,
    HTMLSelectElement: FakeSelectElement,
    MutationObserver: FakeMutationObserver,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
    Promise,
    __ATS_SEND_MESSAGE__: async message => { sent.push(message); return { ok: true }; }
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(read('src/content/casatrade-expiration-probe.js'), sandbox);
  return { runtime: sandbox.__ATS_EXPIRATION_PROBE_RUNTIME__, sent, sandbox };
}

test('video 14814: visible Expiração + 1 min wins even with dropdown options open', () => {
  const { runtime } = expirationHarness('1 min');
  assert.equal(runtime.version, 'expiration-real-v3');
  const snapshot = runtime.scan();
  assert.equal(snapshot.expiration, '60s');
  assert.ok(snapshot.confidence.expiration >= 110);
});

test('video 14814: visible Expiração + 5 seg remains 5s and is not replaced by 1 min option', () => {
  const { runtime } = expirationHarness('5 seg');
  const snapshot = runtime.scan();
  assert.equal(snapshot.expiration, '5s');
  assert.notEqual(snapshot.expiration, '60s');
});

test('expiration parser converts real CasaTrade labels to seconds', () => {
  const { runtime } = expirationHarness('1 min');
  assert.equal(runtime.parseExpiration('1 min'), '60s');
  assert.equal(runtime.parseExpiration('5 seg'), '5s');
  assert.equal(runtime.parseExpiration('30 seg'), '30s');
  assert.equal(runtime.parseExpiration('00:01:00'), '60s');
  assert.equal(runtime.parseExpiration('Expiração 1 min'), '60s');
});

test('expiration probe is restartable after extension reader reinjection', () => {
  const { sandbox } = expirationHarness('1 min');
  const first = sandbox.__ATS_EXPIRATION_PROBE_RUNTIME__;
  assert.equal(first.version, 'expiration-real-v3');
  vm.runInNewContext(read('src/content/casatrade-expiration-probe.js'), sandbox);
  const second = sandbox.__ATS_EXPIRATION_PROBE_RUNTIME__;
  assert.equal(second.version, 'expiration-real-v3');
  assert.notEqual(second, first);
});

test('clock emits no structured/local estimated countdown authority', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.doesNotMatch(clock, /clockSource:\s*'platform-cycle-derived'/);
  assert.doesNotMatch(clock, /clockMode:\s*'structured-candle-boundary-fallback'/);
  assert.match(clock, /clockSource:\s*'casatrade-clock-pending'/);
  assert.match(clock, /available:\s*false,\s*verified:\s*false,\s*operational:\s*false/);

  const projector = read('src/content/market-clock-projector.js');
  assert.doesNotMatch(projector, /type:\s*'ATS_MARKET_CLOCK_V2'/);
  assert.match(projector, /enabled:\s*false/);
  assert.match(projector, /authoritative-casatrade-clock-only/);
});

test('sidepanel never presents missing clock/expiration as an estimate or fabricated error value', () => {
  const app = read('src/sidepanel/app-v2.js');
  assert.doesNotMatch(app, /COUNTDOWN ESTIMADO/);
  assert.doesNotMatch(app, /~ ESTIMADO/);
  assert.match(app, /EXPIRAÇÃO PENDENTE/);
  assert.match(app, /COUNTDOWN REAL PENDENTE/);
  assert.match(app, /Ajuste a expiração da CasaTrade para 1 minuto/i);
  assert.match(app, /Aguardando countdown real da CasaTrade; nenhum tempo local é usado/);
});

test('existing 30s -> 10s -> final decision contract remains tied to exact CasaTrade time', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /EXACT_CLOCK_SOURCES = new Set\(\['trader-dom-countdown', 'network-server-cycle'\]\)/);
  assert.match(policy, /if \(!Number\.isFinite\(seconds\) \|\| seconds > 30\)/);
  assert.match(policy, /if \(seconds <= 0\)/);
  assert.match(policy, /if \(seconds > 10\)/);
  assert.match(policy, /if \(!expiration\.ready\)/);
});
