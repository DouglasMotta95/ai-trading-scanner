import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(root, rel));
const manifest = JSON.parse(read('manifest.json'));

function walk(dirRel) {
  const abs = path.join(root, dirRel);
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dirRel.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

function localHtmlRefs(source) {
  const refs = [];
  const re = /(?:src|href)=["']([^"']+)["']/gi;
  for (const match of source.matchAll(re)) {
    const value = match[1].trim();
    if (!value || value.startsWith('#') || /^(?:https?:|data:|mailto:|tel:|javascript:)/i.test(value)) continue;
    refs.push(value.split(/[?#]/)[0]);
  }
  return refs;
}

function relativeModuleRefs(source) {
  const refs = new Set();
  const staticRe = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
  const dynamicRe = /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe]) for (const match of source.matchAll(re)) refs.add(match[1]);
  return [...refs];
}

function resolveModule(fromRel, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.posix.join(base, 'index.js')];
  return candidates.find(exists) || null;
}

test('manifest points only to files that exist', () => {
  const refs = [manifest.background?.service_worker, manifest.options_page, manifest.side_panel?.default_path];
  for (const group of manifest.content_scripts || []) refs.push(...(group.js || []), ...(group.css || []));
  for (const group of manifest.web_accessible_resources || []) refs.push(...(group.resources || []));
  for (const rel of refs.filter(Boolean)) assert.ok(exists(rel), `manifest references missing file: ${rel}`);
});

test('every local JS import/export target exists', () => {
  const jsFiles = walk('src').filter(file => /\.(?:js|mjs)$/.test(file));
  const missing = [];
  for (const file of jsFiles) {
    const source = read(file);
    for (const specifier of relativeModuleRefs(source)) {
      if (!resolveModule(file, specifier)) missing.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(missing, [], `missing module targets:\n${missing.join('\n')}`);
});

test('extension HTML references only local files that exist', () => {
  const htmlFiles = walk('src').filter(file => file.endsWith('.html'));
  const missing = [];
  for (const file of htmlFiles) {
    for (const ref of localHtmlRefs(read(file))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref));
      if (!exists(target)) missing.push(`${file} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, [], `missing HTML assets:\n${missing.join('\n')}`);
});

test('MAIN-world fallback and recovery injector stay in parity with manifest', () => {
  const mainGroups = (manifest.content_scripts || []).filter(group => group.world === 'MAIN');
  const mainFiles = [...new Set(mainGroups.flatMap(group => group.js || []))];
  assert.ok(mainFiles.length > 0, 'manifest has no MAIN-world scripts');

  const bootstrap = read('src/content/page-world-bootstrap.js');
  const injector = read('src/background-modern-injector.js');
  const webAccessible = new Set((manifest.web_accessible_resources || []).flatMap(group => group.resources || []));

  for (const file of mainFiles) {
    assert.ok(webAccessible.has(file), `MAIN-world script is not web-accessible for fallback injection: ${file}`);
    assert.ok(bootstrap.includes(`'${file}'`) || bootstrap.includes(`"${file}"`), `page-world fallback omits MAIN-world script: ${file}`);
    assert.ok(injector.includes(`'${file}'`) || injector.includes(`"${file}"`), `modern recovery injector omits MAIN-world script: ${file}`);
  }
});

test('content-script host matches are covered by host_permissions', () => {
  const allowed = new Set(manifest.host_permissions || []);
  const missing = [];
  for (const group of manifest.content_scripts || []) {
    for (const match of group.matches || []) if (!allowed.has(match)) missing.push(match);
  }
  assert.deepEqual([...new Set(missing)], [], `content-script matches missing from host_permissions: ${missing.join(', ')}`);
});

test('literal Railway extension endpoints are allowed by manifest', () => {
  const allowed = new Set(manifest.host_permissions || []);
  const files = walk('src').filter(file => file.endsWith('.js'));
  const missing = new Set();
  const urlRe = /https:\/\/[a-z0-9.-]+\.up\.railway\.app/gi;
  for (const file of files) {
    for (const match of read(file).matchAll(urlRe)) {
      const permission = `${match[0]}/*`;
      if (!allowed.has(permission)) missing.add(`${file}: ${permission}`);
    }
  }
  assert.deepEqual([...missing], [], `Railway endpoint not covered by host_permissions:\n${[...missing].join('\n')}`);
});

test('callback-only runtime compatibility is not bypassed by Promise-only sendMessage usage', () => {
  const files = walk('src/content').filter(file => file.endsWith('.js'));
  const bad = [];
  for (const file of files) {
    const source = read(file);
    if (/await\s+chrome\.runtime\.sendMessage\s*\(/.test(source)) bad.push(`${file}: await chrome.runtime.sendMessage`);
    if (/chrome\.runtime\.sendMessage\s*\([^;\n]*\)\s*\.(?:then|catch)\s*\(/.test(source)) bad.push(`${file}: Promise chaining on chrome.runtime.sendMessage`);
  }
  assert.deepEqual(bad, [], `callback-only Android runtime hazards:\n${bad.join('\n')}`);
});

test('runtime compatibility bridge loads before isolated live readers', () => {
  for (const group of manifest.content_scripts || []) {
    if (group.world === 'MAIN') continue;
    const files = group.js || [];
    if (!files.some(file => file.startsWith('src/content/'))) continue;
    const liveReaders = files.filter(file => !file.endsWith('runtime-message-compat.js'));
    if (!liveReaders.length) continue;
    assert.equal(files[0], 'src/content/runtime-message-compat.js', `runtime-message-compat.js must load first in isolated group: ${files.join(', ')}`);
  }

  const injector = read('src/background-modern-injector.js');
  const compatIndex = injector.indexOf("'src/content/runtime-message-compat.js'");
  assert.ok(compatIndex >= 0, 'modern recovery injector omits runtime-message-compat.js');
  for (const file of ['focused-asset-v2.js','embedded-feed-bridge.js','platform-sync.js','market-cycle-clock-v4.js','account-metrics-observer.js','analysis-visual-overlay-v2.js']) {
    assert.ok(injector.indexOf(file) > compatIndex, `${file} must be injected after runtime compatibility`);
  }
});

test('manifest version and version_name remain aligned', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(String(manifest.version_name || '').startsWith(manifest.version), `version_name ${manifest.version_name} does not start with version ${manifest.version}`);
});
