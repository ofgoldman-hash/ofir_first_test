import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRules, classify, detectRecurring, summarize, findRule } from '../public/js/classify.js';

const tx = (date, description, amount, extra = {}) => classify({ date, description, amount, ...extra }, defaultRules());

test('default rules classify common Israeli payees', () => {
  assert.equal(tx('2026-01-01', 'משכורת ינואר', 15000).kind, 'fixed');
  assert.equal(tx('2026-01-02', 'שופרסל דיל ת"א', -300).category, 'מזון וסופר');
  assert.equal(tx('2026-01-03', 'EL AL ISRAEL AIRLINES', -4000).kind, 'oneoff');
  assert.equal(tx('2026-01-04', 'ישראכרט בע"מ', -6000).kind, 'transfer');
  const other = tx('2026-01-05', 'משהו לא מוכר', -50);
  assert.equal(other.kind, 'variable');
  assert.equal(other.category, 'אחר');
});

test('manual classification is never overwritten', () => {
  const t = tx('2026-01-01', 'שופרסל', -100, { manual: true, kind: 'oneoff', category: 'מתנות ותרומות' });
  assert.equal(t.kind, 'oneoff');
  assert.equal(t.category, 'מתנות ותרומות');
});

test('rules with a trailing space match word starts only', () => {
  const rules = [{ match: 'מי ', category: 'חשבונות הבית', kind: 'fixed' }];
  assert.ok(findRule('מי אביבים', rules));
  assert.equal(findRule('מימון', rules), null);
});

test('recurring payments are suggested', () => {
  const txs = ['01', '02', '03', '04'].map(m => tx(`2026-${m}-10`, `חוג כדורגל ${m}`, -250));
  txs.push(tx('2026-01-15', 'מסעדה', -100), tx('2026-03-15', 'מסעדה', -900), tx('2026-04-15', 'מסעדה', -40));
  const s = detectRecurring(txs);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, 'חוג כדורגל');
  assert.equal(s[0].months, 4);
  assert.equal(s[0].avg, -250);
});

test('summary splits months into layers and excludes transfers', () => {
  const txs = [
    tx('2026-01-01', 'משכורת', 20000),
    tx('2026-01-02', 'משכנתא', -6000),
    tx('2026-01-05', 'שופרסל', -3000),
    tx('2026-01-09', 'ישראכרט', -9999),
    tx('2026-02-01', 'משכורת', 20000),
    tx('2026-02-02', 'משכנתא', -6000),
    tx('2026-02-20', 'booking.com', -8000, {}),
  ];
  txs[6].event = 'חופשה ביוון';
  const s = summarize(txs);
  assert.equal(s.monthCount, 2);
  assert.deepEqual(s.months[0], {
    month: '2026-01', fixedIncome: 20000, varIncome: 0, fixedExp: 6000, varExp: 3000, oneoffExp: 0, oneoffIncome: 0, net: 11000,
  });
  assert.equal(s.avg.structural, 14000);
  assert.equal(s.avg.routine, 12500);
  assert.equal(s.totals.oneoffExp, 8000);
  assert.deepEqual(s.events.map(e => [e.name, e.total]), [['חופשה ביוון', 8000]]);
  assert.equal(summarize(txs, '2026-02', '2026-02').monthCount, 1);
});
