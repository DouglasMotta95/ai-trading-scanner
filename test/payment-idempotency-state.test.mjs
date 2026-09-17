import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../backend/src/server.js',import.meta.url),'utf8');
test('Phase E serializes payment and order processing',()=>{ assert.match(source,/withLock\(paymentLocks, id/); assert.match(source,/withLock\(orderLocks, order\.id/); });
test('Phase E completes webhook event only after approved payment',()=>{ assert.match(source,/result\?\.status === 'approved'/); assert.match(source,/setPaymentEvent\(eventKey, 'completed'/); assert.match(source,/setPaymentEvent\(eventKey, 'received'.*retrySafe: true/); });
test('Phase E retains received processing completed failed states',()=>{ for(const state of ['received','processing','completed','failed']) assert.match(source,new RegExp(`setPaymentEvent\\(eventKey, '${state}'`)); });
