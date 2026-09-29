// Categorisation rules, recurring-payment detection and the budget "layers" summary.

export const KINDS = {
  fixed: 'קבוע',
  variable: 'משתנה',
  oneoff: 'חד-פעמי',
  transfer: 'לא נספר',
};

export const CATEGORIES = [
  'משכורת', 'קצבאות', 'הכנסה אחרת',
  'משכנתא ושכירות', 'חשבונות הבית', 'תקשורת', 'ביטוחים', 'חינוך וילדים', 'הלוואות',
  'מזון וסופר', 'מסעדות ובילוי', 'רכב ודלק', 'תחבורה', 'בריאות', 'ביגוד והנעלה', 'קניות לבית',
  'נסיעות וחופשות', 'מתנות ותרומות', 'חיסכון והשקעות', 'עמלות בנק', 'העברות', 'אחר',
];

let ruleSeq = 0;
const rule = (match, category, kind) => ({ id: `d${++ruleSeq}`, match, category, kind });

// Sensible Israeli defaults; the user can edit/delete them.
export function defaultRules() {
  ruleSeq = 0;
  return [
    rule('משכורת', 'משכורת', 'fixed'),
    rule('ביטוח לאומי', 'קצבאות', 'fixed'),
    rule('משכנתא', 'משכנתא ושכירות', 'fixed'),
    rule('שכר דירה', 'משכנתא ושכירות', 'fixed'),
    rule('ארנונה', 'חשבונות הבית', 'fixed'),
    rule('חברת החשמל', 'חשבונות הבית', 'fixed'),
    rule('חשמל', 'חשבונות הבית', 'fixed'),
    rule('מי ', 'חשבונות הבית', 'fixed'),
    rule('תאגיד', 'חשבונות הבית', 'fixed'),
    rule('ועד בית', 'חשבונות הבית', 'fixed'),
    rule('סופרגז', 'חשבונות הבית', 'fixed'),
    rule('פזגז', 'חשבונות הבית', 'fixed'),
    rule('בזק', 'תקשורת', 'fixed'),
    rule('הוט', 'תקשורת', 'fixed'),
    rule('פרטנר', 'תקשורת', 'fixed'),
    rule('סלקום', 'תקשורת', 'fixed'),
    rule('פלאפון', 'תקשורת', 'fixed'),
    rule('גולן טלקום', 'תקשורת', 'fixed'),
    rule('netflix', 'תקשורת', 'fixed'),
    rule('spotify', 'תקשורת', 'fixed'),
    rule('ביטוח', 'ביטוחים', 'fixed'),
    rule('הראל', 'ביטוחים', 'fixed'),
    rule('מגדל', 'ביטוחים', 'fixed'),
    rule('כלל ביטוח', 'ביטוחים', 'fixed'),
    rule('הפניקס', 'ביטוחים', 'fixed'),
    rule('מכבי', 'בריאות', 'fixed'),
    rule('כללית', 'בריאות', 'fixed'),
    rule('מאוחדת', 'בריאות', 'fixed'),
    rule('לאומית', 'בריאות', 'fixed'),
    rule('צהרון', 'חינוך וילדים', 'fixed'),
    rule('גן ', 'חינוך וילדים', 'fixed'),
    rule('הלוואה', 'הלוואות', 'fixed'),
    rule('הוראת קבע', 'אחר', 'fixed'),
    rule('שופרסל', 'מזון וסופר', 'variable'),
    rule('רמי לוי', 'מזון וסופר', 'variable'),
    rule('ויקטורי', 'מזון וסופר', 'variable'),
    rule('יוחננוף', 'מזון וסופר', 'variable'),
    rule('אושר עד', 'מזון וסופר', 'variable'),
    rule('טיב טעם', 'מזון וסופר', 'variable'),
    rule('מגה', 'מזון וסופר', 'variable'),
    rule('am:pm', 'מזון וסופר', 'variable'),
    rule('wolt', 'מסעדות ובילוי', 'variable'),
    rule('תן ביס', 'מסעדות ובילוי', 'variable'),
    rule('10bis', 'מסעדות ובילוי', 'variable'),
    rule('פז ', 'רכב ודלק', 'variable'),
    rule('סונול', 'רכב ודלק', 'variable'),
    rule('דור אלון', 'רכב ודלק', 'variable'),
    rule('דלק', 'רכב ודלק', 'variable'),
    rule('ten ', 'רכב ודלק', 'variable'),
    rule('כביש 6', 'רכב ודלק', 'variable'),
    rule('פנגו', 'רכב ודלק', 'variable'),
    rule('סופר-פארם', 'בריאות', 'variable'),
    rule('סופר פארם', 'בריאות', 'variable'),
    rule('רב קו', 'תחבורה', 'variable'),
    rule('gett', 'תחבורה', 'variable'),
    rule('אל על', 'נסיעות וחופשות', 'oneoff'),
    rule('el al', 'נסיעות וחופשות', 'oneoff'),
    rule('ישראייר', 'נסיעות וחופשות', 'oneoff'),
    rule('ארקיע', 'נסיעות וחופשות', 'oneoff'),
    rule('booking', 'נסיעות וחופשות', 'oneoff'),
    rule('airbnb', 'נסיעות וחופשות', 'oneoff'),
    rule('ryanair', 'נסיעות וחופשות', 'oneoff'),
    rule('wizz', 'נסיעות וחופשות', 'oneoff'),
    rule('easyjet', 'נסיעות וחופשות', 'oneoff'),
    rule('expedia', 'נסיעות וחופשות', 'oneoff'),
    rule('hotel', 'נסיעות וחופשות', 'oneoff'),
    rule('מלון', 'נסיעות וחופשות', 'oneoff'),
    rule('duty free', 'נסיעות וחופשות', 'oneoff'),
    rule('עמלה', 'עמלות בנק', 'variable'),
    rule('דמי ניהול', 'עמלות בנק', 'fixed'),
    // Card totals on the bank statement duplicate the card statement itself.
    rule('ישראכרט', 'העברות', 'transfer'),
    rule('כרטיסי אשראי', 'העברות', 'transfer'),
    rule('לאומי קארד', 'העברות', 'transfer'),
    rule('מקס איט', 'העברות', 'transfer'),
    rule('כאל', 'העברות', 'transfer'),
    rule('אמריקן אקספרס', 'העברות', 'transfer'),
    rule('דיינרס', 'העברות', 'transfer'),
    rule('העברה בין חשבונות', 'העברות', 'transfer'),
  ];
}

export function normalizeDesc(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[‎‏"'״׳]/g, '')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s:&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Rules are matched against " desc " so a rule like "מי " matches a word start/end.
export function findRule(description, rules) {
  const hay = ` ${String(description ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
  const normHay = ` ${normalizeDesc(description)} `;
  return rules.find(r => {
    const m = String(r.match ?? '').toLowerCase();
    return m.trim() && (hay.includes(m) || normHay.includes(m));
  }) || null;
}

export function classify(tx, rules) {
  if (tx.manual) return tx;
  const r = findRule(tx.description, rules);
  if (r) {
    tx.category = r.category;
    tx.kind = r.kind;
  } else {
    tx.category = tx.amount > 0 ? 'הכנסה אחרת' : 'אחר';
    tx.kind = 'variable';
  }
  return tx;
}

export const monthOf = date => date.slice(0, 7);

// Suggest payments that repeat monthly with a stable amount but are not yet "fixed".
export function detectRecurring(transactions, { minMonths = 3, maxCv = 0.25 } = {}) {
  const groups = new Map();
  for (const t of transactions) {
    if (t.kind === 'transfer') continue;
    const key = normalizeDesc(t.description).split(' ').slice(0, 3).join(' ');
    if (!key) continue;
    const gk = `${t.amount > 0 ? '+' : '-'}${key}`;
    if (!groups.has(gk)) groups.set(gk, { key, sign: Math.sign(t.amount), txs: [] });
    groups.get(gk).txs.push(t);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.txs.every(t => t.kind === 'fixed')) continue;
    const byMonth = new Map();
    for (const t of g.txs) byMonth.set(monthOf(t.date), (byMonth.get(monthOf(t.date)) || 0) + Math.abs(t.amount));
    if (byMonth.size < minMonths) continue;
    const vals = [...byMonth.values()];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    if (mean === 0 || sd / mean > maxCv) continue;
    out.push({
      key: g.key, sign: g.sign, months: byMonth.size,
      avg: Math.round(mean * g.sign), sample: g.txs[g.txs.length - 1].description,
      category: g.txs[g.txs.length - 1].category,
    });
  }
  return out.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
}

const emptyMonth = month => ({
  month, fixedIncome: 0, varIncome: 0, fixedExp: 0, varExp: 0, oneoffExp: 0, oneoffIncome: 0, net: 0,
});

// Splits every month into layers. Expenses are reported as positive numbers.
export function summarize(transactions, fromMonth = '0000-00', toMonth = '9999-99') {
  const months = new Map();
  const categories = new Map();
  const events = new Map();
  for (const t of transactions) {
    const m = monthOf(t.date);
    if (m < fromMonth || m > toMonth || t.kind === 'transfer') continue;
    if (!months.has(m)) months.set(m, emptyMonth(m));
    const b = months.get(m);
    const a = t.amount;
    if (a > 0) {
      if (t.kind === 'fixed') b.fixedIncome += a;
      else if (t.kind === 'oneoff') b.oneoffIncome += a;
      else b.varIncome += a;
    } else {
      const e = -a;
      if (t.kind === 'fixed') b.fixedExp += e;
      else if (t.kind === 'oneoff') b.oneoffExp += e;
      else b.varExp += e;
      const c = t.category || 'אחר';
      if (!categories.has(c)) categories.set(c, { category: c, fixed: 0, variable: 0, oneoff: 0, total: 0 });
      const cb = categories.get(c);
      cb[t.kind === 'fixed' ? 'fixed' : t.kind === 'oneoff' ? 'oneoff' : 'variable'] += e;
      cb.total += e;
    }
    b.net += a;
    if (t.kind === 'oneoff') {
      const name = t.event || t.category || 'חד-פעמי';
      if (!events.has(name)) events.set(name, { name, total: 0, count: 0, from: t.date, to: t.date });
      const ev = events.get(name);
      ev.total += -a; ev.count++;
      if (t.date < ev.from) ev.from = t.date;
      if (t.date > ev.to) ev.to = t.date;
    }
  }
  const list = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const n = list.length || 1;
  const sum = k => list.reduce((s, b) => s + b[k], 0);
  const totals = {};
  for (const k of Object.keys(emptyMonth(''))) if (k !== 'month') totals[k] = sum(k);
  const avg = {};
  for (const k of Object.keys(totals)) avg[k] = totals[k] / n;
  avg.structural = avg.fixedIncome - avg.fixedExp;
  avg.routine = avg.fixedIncome + avg.varIncome - avg.fixedExp - avg.varExp;
  return {
    months: list,
    monthCount: list.length,
    totals,
    avg,
    categories: [...categories.values()].sort((a, b) => b.total - a.total),
    events: [...events.values()].sort((a, b) => b.total - a.total),
  };
}
