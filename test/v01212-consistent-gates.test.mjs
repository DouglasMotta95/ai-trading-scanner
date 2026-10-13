import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateProfileEntryGate } from '../src/core/profile-entry-gates.js';
import { getSignalPolicy } from '../src/core/analysis.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('profile thresholds control POSSÍVEL and final decision with power 45', () => {
  const expected = { RIGIDO: [58, 62], MEDIO: [52, 55], SOLTO: [45, 50] };
  for (const [profile, [possible, final]] of Object.entries(expected)) {
    const policy = getSignalPolicy(profile);
    assert.equal(policy.possibleScore, possible);
    assert.equal(policy.finalScore, final);
    assert.equal(policy.possiblePower, 45);
    assert.equal(policy.finalPower, 45);
    assert.equal(evaluateProfileEntryGate({ profile, direction: 'BUY', score: possible, buyPower: 45 }).candidate, true);
    assert.equal(evaluateProfileEntryGate({ profile, direction: 'SELL', score: final, sellPower: 45, secondsRemaining: 10, timeframe: 'M1' }).finalEligible, true);
  }
});

test('direction, power and final windows are independent hard conditions', () => {
  assert.equal(evaluateProfileEntryGate({ profile:'MEDIO', direction:null, score:90, buyPower:90, secondsRemaining:5 }).candidate, false);
  assert.equal(evaluateProfileEntryGate({ profile:'MEDIO', direction:'BUY', score:80, buyPower:44, secondsRemaining:5 }).candidate, false);
  assert.equal(evaluateProfileEntryGate({ profile:'MEDIO', direction:'BUY', score:55, buyPower:45, secondsRemaining:11, timeframe:'M1' }).finalEligible, false);
  assert.equal(evaluateProfileEntryGate({ profile:'MEDIO', direction:'BUY', score:55, buyPower:45, secondsRemaining:15, timeframe:'M5' }).finalEligible, true);
});

test('central policy has no competing confluence gate and preserves a candidate through a stale clock', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /evaluateProfileEntryGate/);
  assert.match(policy, /canKeepProfileCandidate/);
  assert.match(policy, /profileGate\.candidate/);
  assert.doesNotMatch(policy, /additionalConfluenceReady/);
  assert.doesNotMatch(policy, /score >= Math\.max\(58, thresholds\.possibleScore\)/);
  assert.match(policy, /POSSÍVEL ' \+ side \+ ' — perfil atingido; aguardando score final/);
});

test('pattern guidance uses profile limits, not competing fixed force wording', () => {
  const analysis = read('src/core/analysis.js');
  assert.match(analysis, /profile_candidate/);
  assert.match(analysis, /profilePolicy\.possibleScore/);
  assert.doesNotMatch(analysis, /Aguardando força do padrão atingir/);
});

test('same-candle score survives transient feed gaps and resets on new candle', async () => {
  const { createScoreStabilizer } = await import('../src/core/score-stability.js');
  const smoother = createScoreStabilizer();
  assert.equal(smoother.update({ key:'EUR/USD|M1|1', rawScore:88, ready:true, at:1000 }), 88);
  assert.equal(smoother.update({ key:'EUR/USD|M1|1', rawScore:0, ready:false, at:1650 }), 88);
  const recovered = smoother.update({ key:'EUR/USD|M1|1', rawScore:25, ready:true, at:2300 });
  assert.ok(recovered < 88 && recovered > 75);
  assert.equal(smoother.update({ key:'EUR/USD|M1|2', rawScore:25, ready:true, at:2950 }), 25);
});

test('Gemini outage is secondary and the Radar respects a primary candidate', () => {
  const ai = read('src/sidepanel/ai-analysis-ui.js');
  const radar = read('src/sidepanel/market-radar-ui.js');
  assert.match(ai, /if \(topStatus\) topStatus\.hidden = true/);
  assert.doesNotMatch(ai, /setTop\('IA INDISPONÍVEL'/);
  assert.match(radar, /primaryEngineCandidate/);
  assert.match(radar, /O Radar é complementar/);
  assert.doesNotMatch(radar, /Nenhuma oportunidade com histórico suficiente e qualidade mínima agora/);
});

test('v0.12.13 identifies the release and preserves manual operation', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, '0.12.13');
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.version_name, '0.12.13-audited-release-portal-sync');
  assert.match(read('src/background-decision-policy.js'), /Entrada MANUAL na próxima vela/);
  assert.match(read('src/sidepanel/index.html'), /SEM EXECUÇÃO AUTOMÁTICA/);
});
