import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('live decision loop writes structured audit without replacing the decision engine', () => {
  const policy = read('src/background-decision-policy.js');
  assert.match(policy, /import \{ buildDecisionAudit, appendDecisionAudit \} from '\.\/core\/decision-audit\.js'/);
  assert.match(policy, /const auditRow = buildDecisionAudit\(state, decision\)/);
  assert.match(policy, /decisionAudit: audit/);
  assert.match(policy, /professionalDecision: next/);
});

test('signal dispatcher records eligibility blocker and actual notification/sound result', () => {
  const alerts = read('src/background-system-alerts.js');
  assert.match(alerts, /explainDecisionAlertEligibility\(state\)/);
  assert.match(alerts, /status: 'not_eligible'/);
  assert.match(alerts, /notification: !notificationsEnabled \? 'disabled' : notificationDelivered \? 'delivered' : 'failed'/);
  assert.match(alerts, /sound: !soundEnabled \? 'disabled' : soundDelivered \? 'delivered' : 'failed'/);
  assert.match(alerts, /status: delivered \? 'delivered' : 'failed'/);
  assert.match(alerts, /updateDecisionAuditDelivery/);
});

test('panel exposes all five audit sections and the trace is included in copied diagnostics', () => {
  const panel = read('src/sidepanel/ui-shell-v2.js');
  assert.match(panel, /id="auditScoreDirection"/);
  assert.match(panel, /id="auditPatternTrigger"/);
  assert.match(panel, /id="auditBlocker"/);
  assert.match(panel, /id="auditTiming"/);
  assert.match(panel, /id="auditDelivery"/);
  assert.match(panel, /decisionAuditLines/);
  assert.match(panel, /8\. RASTRO COMPLETO DA DECISÃO E ENTREGA DO SINAL/);
});

test('audit history stays capped and delivery updates only the matching cycle event', () => {
  const audit = read('src/core/decision-audit.js');
  assert.match(audit, /\.slice\(-Math\.max\(5, Number\(maxEvents\) \|\| 40\)\)/);
  assert.match(audit, /row\.cycleKey === match\.cycleKey/);
  assert.match(audit, /row\.id === match\.id/);
});
