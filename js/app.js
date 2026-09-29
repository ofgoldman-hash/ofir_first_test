import * as store from './storage.js';
import { readFileRows, findHeaderRow, detectColumns, buildTransactions } from './parser.js';
import { KINDS, CATEGORIES, defaultRules, classify, detectRecurring, summarize, normalizeDesc, monthOf } from './classify.js';
import { netChart, layersChart, LAYERS } from './charts.js';
import { esc, money, moneyExact, monthLabel, dateLabel } from './format.js';

const $ = sel => document.querySelector(sel);
const app = $('#app');

const state = {
  session: null,
  data: null,
  view: 'dashboard',
  period: '12',
  filters: { month: '', kind: '', category: '', q: '', limit: 200 },
  pending: [], // parsed files waiting for confirmation
  message: '',
  lastActivity: Date.now(),
};

// ---------- persistence ----------

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  const { session, data } = state;
  saveTimer = setTimeout(async () => {
    try {
      await store.saveVault(session, data);
      if (!$('#status')?.textContent) flash('נשמר (מוצפן)'); // don't hide a more useful message
    } catch (e) {
      flash('שמירה נכשלה: ' + e.message, true);
    }
  }, 300);
}

function flash(text, error = false) {
  const el = $('#status');
  if (!el) return;
  el.textContent = text;
  el.className = error ? 'status error' : 'status';
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.textContent = ''; }, 2500);
}

function lock() {
  clearTimeout(saveTimer);
  state.session = null;
  state.data = null;
  state.pending = [];
  render();
}

// Auto-lock after inactivity.
['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { state.lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!state.data) return;
  const minutes = state.data.settings?.autoLockMinutes || 15;
  if (Date.now() - state.lastActivity > minutes * 60000) lock();
}, 20000);

// ---------- helpers ----------

const txs = () => state.data.transactions;
const allMonths = () => [...new Set(txs().map(t => monthOf(t.date)))].sort();
const allCategories = () => [...new Set([...CATEGORIES, ...txs().map(t => t.category).filter(Boolean)])];
const allEvents = () => [...new Set(txs().map(t => t.event).filter(Boolean))].sort();

function reclassifyAll() {
  for (const t of txs()) classify(t, state.data.rules);
}

function kindSelect(value, attrs) {
  return `<select ${attrs}>${Object.entries(KINDS).map(([k, v]) =>
    `<option value="${k}"${k === value ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function periodRange() {
  const months = allMonths();
  if (!months.length) return ['0000-00', '9999-99'];
  if (state.period === 'all') return [months[0], months[months.length - 1]];
  if (state.period === '12') return [months[Math.max(0, months.length - 12)], months[months.length - 1]];
  return [`${state.period}-01`, `${state.period}-12`];
}

// ---------- views ----------

async function renderLock() {
  const exists = await store.hasVault();
  app.innerHTML = `
  <section class="lock card">
    <h1>התקציב המשפחתי</h1>
    <p class="muted">הנתונים נשמרים מוצפנים (AES-256) רק בדפדפן הזה. שום מידע לא נשלח לשרת.</p>
    ${exists ? `
      <form data-form="unlock">
        <label>סיסמה<input type="password" name="pass" autocomplete="current-password" required autofocus></label>
        <button class="primary" type="submit">פתיחה</button>
      </form>` : `
      <form data-form="create">
        <label>בחרו סיסמה (לפחות 10 תווים)<input type="password" name="pass" minlength="10" autocomplete="new-password" required autofocus></label>
        <label>אימות סיסמה<input type="password" name="pass2" minlength="10" autocomplete="new-password" required></label>
        <p class="warn">⚠ אין אפשרות לשחזר סיסמה שנשכחה – בלעדיה אי אפשר לפענח את הנתונים.</p>
        <button class="primary" type="submit">יצירת כספת מוצפנת</button>
      </form>`}
    <p class="error" id="lock-error" role="alert">${esc(state.message)}</p>
    <details>
      <summary>שחזור מגיבוי</summary>
      <p class="muted">טעינת קובץ גיבוי מוצפן תחליף את הנתונים השמורים בדפדפן זה.</p>
      <input type="file" accept=".json,application/json" data-change="restore-file">
    </details>
  </section>`;
  state.message = '';
}

function renderShell(content) {
  const tabs = [['dashboard', 'מאזן'], ['transactions', 'תנועות'], ['import', 'ייבוא תדפיסים'], ['rules', 'כללים'], ['settings', 'הגדרות']];
  app.innerHTML = `
  <header class="top">
    <strong class="brand">התקציב המשפחתי</strong>
    <nav>${tabs.map(([k, v]) => `<button class="tab${state.view === k ? ' active' : ''}" data-action="nav" data-view="${k}">${v}</button>`).join('')}</nav>
    <span id="status" class="status" aria-live="polite"></span>
    <button data-action="lock" title="נעילה">🔒 נעילה</button>
  </header>
  <main>${content}</main>`;
  hydrate();
}

function kpi(label, value, note = '', tone = '') {
  return `<div class="kpi ${tone}"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span>${note ? `<span class="kpi-note">${note}</span>` : ''}</div>`;
}

const signBadge = v => v >= 0 ? '<span class="badge good">▲ חיובי</span>' : '<span class="badge bad">▼ שלילי</span>';

function renderDashboard() {
  if (!txs().length) {
    return renderShell(`<section class="card empty">
      <h2>עדיין אין נתונים</h2>
      <p>ייבאו תדפיס עו"ש או תדפיס כרטיס אשראי (CSV / Excel) כדי לראות את המאזן המשפחתי.</p>
      <button class="primary" data-action="nav" data-view="import">לייבוא תדפיסים</button></section>`);
  }
  const years = [...new Set(allMonths().map(m => m.slice(0, 4)))].reverse();
  const [from, to] = periodRange();
  const s = summarize(txs(), from, to);
  const a = s.avg;
  const cover = a.fixedExp ? Math.round(a.fixedIncome / a.fixedExp * 100) : 0;
  const oneoffMonths = a.routine > 0 ? (s.totals.oneoffExp / a.routine).toFixed(1) : null;
  const suggestions = detectRecurring(txs()).slice(0, 8);
  const uncategorized = txs().filter(t => !t.manual && (t.category === 'אחר' || t.category === 'הכנסה אחרת')).length;

  const insight = `
    בממוצע נכנסות <b>${money(a.fixedIncome)}</b> הכנסות קבועות בחודש מול <b>${money(a.fixedExp)}</b> הוצאות קבועות
    – ההכנסה הקבועה מכסה <b>${cover}%</b> מההוצאות הקבועות.
    אחרי הוצאות משתנות נשארים <b>${money(a.routine)}</b> בחודש ${a.routine >= 0 ? '(עודף)' : '(גירעון)'}.
    ${s.totals.oneoffExp ? `ההוצאות החד-פעמיות בתקופה הסתכמו ב-<b>${money(s.totals.oneoffExp)}</b>${oneoffMonths ? ` – שווה ערך לכ-${oneoffMonths} חודשי עודף שוטף` : ''}.` : ''}`;

  renderShell(`
  <div class="toolbar">
    <label>תקופה
      <select data-change="period">
        <option value="12"${state.period === '12' ? ' selected' : ''}>12 החודשים האחרונים</option>
        <option value="all"${state.period === 'all' ? ' selected' : ''}>כל הנתונים</option>
        ${years.map(y => `<option value="${y}"${state.period === y ? ' selected' : ''}>${y}</option>`).join('')}
      </select>
    </label>
    <span class="muted">${s.monthCount} חודשים · ממוצע חודשי</span>
  </div>

  <section class="kpis">
    ${kpi('הכנסות קבועות', money(a.fixedIncome))}
    ${kpi('הוצאות קבועות', money(a.fixedExp))}
    ${kpi('מאזן קבוע (מבני)', money(a.structural), signBadge(a.structural), a.structural >= 0 ? 'good' : 'bad')}
    ${kpi('הכנסות משתנות', money(a.varIncome))}
    ${kpi('הוצאות משתנות', money(a.varExp))}
    ${kpi('מאזן שוטף', money(a.routine), signBadge(a.routine) + ' לפני חד-פעמיות', a.routine >= 0 ? 'good' : 'bad')}
    ${kpi('חד-פעמיות בתקופה', money(s.totals.oneoffExp), `${s.events.length} אירועים`)}
    ${kpi('מאזן כולל בתקופה', money(s.totals.net), signBadge(s.totals.net), s.totals.net >= 0 ? 'good' : 'bad')}
  </section>
  <p class="insight card">${insight}</p>
  ${uncategorized ? `<p class="notice">${uncategorized} תנועות עדיין ללא קטגוריה ספציפית. <button class="link" data-action="show-uncategorized">לסיווג</button></p>` : ''}

  <section class="grid2">
    <div class="card">
      <h2>מאזן חודשי</h2>
      <p class="muted">עודף <span class="swatch pos"></span> / גירעון <span class="swatch neg"></span> בכל חודש (כולל חד-פעמיות)</p>
      <div class="chart-wrap">${netChart(s.months)}</div>
    </div>
    <div class="card">
      <h2>שכבות ההוצאה מול ההכנסה</h2>
      <p class="legend">${LAYERS.map(l => `<span><span class="swatch ${l.cls}"></span>${l.label}</span>`).join('')}<span><span class="swatch income"></span>סך ההכנסות</span></p>
      <div class="chart-wrap">${layersChart(s.months)}</div>
    </div>
  </section>

  <section class="card">
    <h2>פירוט חודשי לפי שכבות</h2>
    <div class="table-wrap"><table class="num">
      <thead><tr><th>חודש</th><th>הכנסות קבועות</th><th>הכנסות משתנות</th><th>הוצאות קבועות</th><th>מאזן קבוע</th><th>הוצאות משתנות</th><th>חד-פעמיות</th><th>מאזן</th></tr></thead>
      <tbody>${s.months.slice().reverse().map(m => `<tr>
        <td>${monthLabel(m.month)}</td><td>${money(m.fixedIncome)}</td><td>${money(m.varIncome + m.oneoffIncome)}</td>
        <td>${money(m.fixedExp)}</td><td class="${m.fixedIncome - m.fixedExp >= 0 ? 'pos-t' : 'neg-t'}">${money(m.fixedIncome - m.fixedExp)}</td>
        <td>${money(m.varExp)}</td><td>${money(m.oneoffExp)}</td>
        <td class="${m.net >= 0 ? 'pos-t' : 'neg-t'}"><b>${money(m.net)}</b></td></tr>`).join('')}</tbody>
    </table></div>
  </section>

  <section class="grid2">
    <div class="card">
      <h2>הוצאות לפי קטגוריה</h2>
      <div class="table-wrap"><table class="num">
        <thead><tr><th>קטגוריה</th><th>ממוצע לחודש</th><th>קבוע</th><th>משתנה</th><th>חד-פעמי</th><th></th></tr></thead>
        <tbody>${s.categories.map(c => `<tr>
          <td><button class="link" data-action="filter-category" data-category="${esc(c.category)}">${esc(c.category)}</button></td>
          <td>${money(c.total / (s.monthCount || 1))}</td><td>${money(c.fixed)}</td><td>${money(c.variable)}</td><td>${money(c.oneoff)}</td>
          <td class="barcell"><span class="hbar" data-w="${(c.total / (s.categories[0]?.total || 1) * 100).toFixed(1)}"></span></td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>הוצאות חד-פעמיות ואירועים</h2>
      <p class="muted">סמנו תנועות כ"חד-פעמי" ותנו להן שם אירוע (למשל "חופשה ביוון 2026") כדי לקבץ אותן כאן.</p>
      ${s.events.length ? `<div class="table-wrap"><table class="num">
        <thead><tr><th>אירוע</th><th>תאריכים</th><th>תנועות</th><th>סה"כ</th></tr></thead>
        <tbody>${s.events.map(e => `<tr><td>${esc(e.name)}</td><td>${dateLabel(e.from)}–${dateLabel(e.to)}</td><td>${e.count}</td><td>${money(e.total)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p>אין הוצאות חד-פעמיות בתקופה.</p>'}
    </div>
  </section>

  ${suggestions.length ? `<section class="card">
    <h2>נראה כמו תשלום קבוע</h2>
    <p class="muted">תנועות שחוזרות כמעט בכל חודש בסכום דומה, אבל עדיין לא מסווגות כקבועות.</p>
    <div class="table-wrap"><table class="num">
      <thead><tr><th>תיאור</th><th>חודשים</th><th>ממוצע</th><th></th></tr></thead>
      <tbody>${suggestions.map(r => `<tr><td>${esc(r.sample)}</td><td>${r.months}</td><td>${money(r.avg)}</td>
        <td><button data-action="make-fixed" data-key="${esc(r.key)}" data-category="${esc(r.category || '')}">סמן כקבוע</button></td></tr>`).join('')}</tbody>
    </table></div></section>` : ''}
  `);
}

function filteredTxs() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return txs().filter(t =>
    (!f.month || monthOf(t.date) === f.month)
    && (!f.kind || t.kind === f.kind)
    && (!f.category || (f.category === '__none' ? !t.manual && (t.category === 'אחר' || t.category === 'הכנסה אחרת') : t.category === f.category))
    && (!q || t.description.toLowerCase().includes(q) || (t.event || '').toLowerCase().includes(q) || (t.account || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function renderTransactions() {
  const f = state.filters;
  const list = filteredTxs();
  const shown = list.slice(0, f.limit);
  const income = list.filter(t => t.amount > 0 && t.kind !== 'transfer').reduce((s, t) => s + t.amount, 0);
  const expense = list.filter(t => t.amount < 0 && t.kind !== 'transfer').reduce((s, t) => s - t.amount, 0);
  const cats = allCategories();
  renderShell(`
  <datalist id="cat-list">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  <datalist id="event-list">${allEvents().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  <div class="toolbar">
    <input type="search" placeholder="חיפוש תיאור / אירוע / חשבון" value="${esc(f.q)}" data-filter="q">
    <select data-filter="month"><option value="">כל החודשים</option>${allMonths().reverse().map(m => `<option value="${m}"${f.month === m ? ' selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
    <select data-filter="kind"><option value="">כל הסוגים</option>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${f.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <select data-filter="category"><option value="">כל הקטגוריות</option><option value="__none"${f.category === '__none' ? ' selected' : ''}>ללא סיווג</option>${cats.map(c => `<option value="${esc(c)}"${f.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <span class="muted">${list.length} תנועות · הכנסות ${money(income)} · הוצאות ${money(expense)}</span>
  </div>
  <section class="card">
    <p class="muted">שינוי סוג / קטגוריה נשמר לתנועה עצמה. "כלל" מחיל את הסיווג על כל התנועות הדומות – גם בייבואים הבאים.</p>
    <div class="table-wrap"><table class="tx">
      <thead><tr><th>תאריך</th><th>תיאור</th><th>חשבון</th><th>סכום</th><th>סוג</th><th>קטגוריה</th><th>אירוע</th><th></th></tr></thead>
      <tbody>${shown.map(t => `<tr data-id="${t.id}" class="${t.kind === 'transfer' ? 'dim' : ''}">
        <td>${dateLabel(t.date)}</td>
        <td class="desc">${esc(t.description)}${t.manual ? ' <span class="badge" title="סווג ידנית">✎</span>' : ''}</td>
        <td class="muted">${esc(t.account || '')}</td>
        <td class="amount ${t.amount >= 0 ? 'pos-t' : ''}">${moneyExact(t.amount)}</td>
        <td>${kindSelect(t.kind, 'data-edit="kind" aria-label="סוג"')}</td>
        <td><input list="cat-list" value="${esc(t.category || '')}" data-edit="category" aria-label="קטגוריה"></td>
        <td><input list="event-list" value="${esc(t.event || '')}" data-edit="event" placeholder="—" aria-label="אירוע"></td>
        <td class="actions"><button data-action="make-rule" title="החל על כל התנועות הדומות">כלל</button><button data-action="delete-tx" title="מחיקת תנועה">✕</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${list.length > shown.length ? `<button data-action="more">הצג עוד (${list.length - shown.length})</button>` : ''}
  </section>`);
}

function pendingPreview(p) {
  return buildTransactions(p.rows, p.headerRow, p.map, { invert: p.invert });
}

function renderImport() {
  const cards = state.pending.map((p, i) => {
    if (p.error) return `<div class="card error-card"><b>${esc(p.fileName)}</b>: ${esc(p.error)} <button data-action="drop-pending" data-i="${i}">הסר</button></div>`;
    const header = p.rows[p.headerRow] || [];
    const colOpts = sel => `<option value="-1">—</option>` + header.map((h, c) =>
      `<option value="${c}"${sel === c ? ' selected' : ''}>${esc(h || `עמודה ${c + 1}`)}</option>`).join('');
    const preview = pendingPreview(p);
    const rawRows = p.rows.slice(p.headerRow, p.headerRow + 6);
    const width = Math.max(0, ...rawRows.map(r => r.length));
    return `<div class="card">
      <h3>${esc(p.fileName)} <span class="muted">· ${preview.length} תנועות זוהו</span></h3>
      <div class="mapping">
        <label>שורת כותרות<input type="number" min="1" max="${p.rows.length}" value="${p.headerRow + 1}" data-pending="${i}" data-field="headerRow"></label>
        <label>תאריך<select data-pending="${i}" data-field="date">${colOpts(p.map.date)}</select></label>
        <label>תיאור<select data-pending="${i}" data-field="description">${colOpts(p.map.description)}</select></label>
        <label>סכום<select data-pending="${i}" data-field="amount">${colOpts(p.map.amount)}</select></label>
        <label>חובה<select data-pending="${i}" data-field="debit">${colOpts(p.map.debit)}</select></label>
        <label>זכות<select data-pending="${i}" data-field="credit">${colOpts(p.map.credit)}</select></label>
        <label>שם החשבון<input value="${esc(p.account)}" data-pending="${i}" data-field="account"></label>
        <label class="check"><input type="checkbox" ${p.invert ? 'checked' : ''} data-pending="${i}" data-field="invert">חיובים מופיעים כמספר חיובי (כרטיס אשראי)</label>
      </div>
      ${preview.length ? `<div class="table-wrap"><table class="num"><thead><tr><th>תאריך</th><th>תיאור</th><th>סכום</th></tr></thead>
        <tbody>${preview.slice(0, 8).map(t => `<tr><td>${dateLabel(t.date)}</td><td>${esc(t.description)}</td><td class="${t.amount >= 0 ? 'pos-t' : ''}">${moneyExact(t.amount)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted">בדקו שהוצאות מופיעות במינוס והכנסות בפלוס.</p>` : `
      <p class="warn">לא זוהו תנועות בקובץ. בחרו למעלה את שורת הכותרות ואת העמודות של תאריך, תיאור וסכום (או חובה/זכות). כך נראות השורות הראשונות:</p>
      <div class="table-wrap"><table><tbody>${rawRows.map((r, k) => `<tr><td class="muted">${p.headerRow + k + 1}</td>${
        Array.from({ length: width }, (_, c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
      <button class="primary" data-action="confirm-import" data-i="${i}" ${preview.length ? '' : 'disabled'}>ייבוא ${preview.length} תנועות מהקובץ</button>
      <button data-action="drop-pending" data-i="${i}">ביטול</button>
    </div>`;
  }).join('');

  const total = state.pending.filter(p => !p.error).reduce((n, p) => n + pendingPreview(p).length, 0);
  const pendingSection = state.pending.length ? `
  <section class="card pending-bar" id="pending">
    <h2>${state.pending.length === 1 ? 'קובץ אחד ממתין' : `${state.pending.length} קבצים ממתינים`} לאישור</h2>
    <p>בדקו את התצוגה המקדימה של כל קובץ למטה (הוצאות במינוס, הכנסות בפלוס) ולחצו ייבוא.</p>
    <button class="primary" data-action="import-all" ${total ? '' : 'disabled'}>ייבוא כל הקבצים (${total} תנועות)</button>
    <button data-action="drop-all">ביטול הכל</button>
  </section>
  ${cards}` : '';

  renderShell(`
  ${pendingSection}
  <section class="card">
    <h2>${state.pending.length ? 'הוספת קבצים נוספים' : 'ייבוא תדפיסים'}</h2>
    <p>הורידו מאתר הבנק / חברת האשראי את פירוט התנועות כקובץ <b>Excel (xlsx)</b>, <b>CSV</b> או <b>xls</b>, ובחרו את הקבצים או תיקייה שלמה.
    הקבצים מעובדים בדפדפן בלבד ולא נשמרים – רק התנועות נשמרות, מוצפנות.</p>
    <label class="drop" data-drop>
      <input type="file" multiple accept="${ACCEPT}" data-change="files">
      <span>גררו קבצים או תיקייה לכאן, או לחצו לבחירת קבצים</span>
    </label>
    <label class="button">📁 בחירת תיקייה שלמה<input type="file" webkitdirectory multiple data-change="files" class="sr-only"></label>
    <p class="muted">טיפ: כשמייבאים גם עו"ש וגם כרטיסי אשראי, שורת החיוב החודשי של הכרטיס בעו"ש מסומנת כ"לא נספר" כדי שלא תיספר פעמיים.</p>
  </section>
  ${state.data.imports.length ? `<section class="card"><h2>ייבואים קודמים</h2>
    <div class="table-wrap"><table class="num"><thead><tr><th>קובץ</th><th>חשבון</th><th>תאריך ייבוא</th><th>תנועות</th><th></th></tr></thead>
    <tbody>${state.data.imports.slice().reverse().map(im => `<tr><td>${esc(im.fileName)}</td><td>${esc(im.account)}</td>
      <td>${dateLabel(im.date.slice(0, 10))}</td><td>${im.count}</td>
      <td><button data-action="delete-import" data-id="${im.id}">מחיקת הייבוא</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}
  `);
}

function renderRules() {
  const rules = state.data.rules;
  renderShell(`
  <datalist id="cat-list">${allCategories().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
  <section class="card">
    <h2>כללי סיווג</h2>
    <p class="muted">כל תנועה שהתיאור שלה מכיל את הטקסט מקבלת את הסוג והקטגוריה של הכלל הראשון שמתאים (מלמעלה למטה). תנועות שסווגו ידנית לא משתנות.</p>
    <form data-form="add-rule" class="mapping">
      <label>טקסט בתיאור<input name="match" required></label>
      <label>קטגוריה<input name="category" list="cat-list" required></label>
      <label>סוג${kindSelect('fixed', 'name="kind"')}</label>
      <button class="primary" type="submit">הוספת כלל</button>
    </form>
    <p><button data-action="reapply">החלת הכללים מחדש על כל התנועות</button>
       <button data-action="reset-rules">שחזור כללי ברירת המחדל</button></p>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>טקסט</th><th>קטגוריה</th><th>סוג</th><th></th></tr></thead>
      <tbody>${rules.map((r, i) => `<tr data-rule="${esc(r.id)}"><td>${i + 1}</td><td>${esc(r.match)}</td><td>${esc(r.category)}</td>
        <td>${KINDS[r.kind] || r.kind}</td>
        <td class="actions"><button data-action="rule-up" ${i ? '' : 'disabled'} title="העלאה">▲</button><button data-action="delete-rule" title="מחיקה">✕</button></td></tr>`).join('')}</tbody>
    </table></div>
  </section>`);
}

function renderSettings() {
  renderShell(`
  <section class="card">
    <h2>אבטחה</h2>
    <ul class="plain">
      <li>🔐 הנתונים מוצפנים ב-AES-256-GCM עם מפתח שנגזר מהסיסמה (PBKDF2, ‏600,000 סבבים).</li>
      <li>🖥 הכל נשמר רק בדפדפן הזה (IndexedDB). האתר חסום לשליחת מידע לרשת (Content-Security-Policy).</li>
      <li>⏱ נעילה אוטומטית אחרי חוסר פעילות.</li>
    </ul>
    <label>נעילה אוטומטית אחרי (דקות)
      <input type="number" min="1" max="240" value="${state.data.settings.autoLockMinutes || 15}" data-change="autolock"></label>
  </section>
  <section class="card">
    <h2>החלפת סיסמה</h2>
    <form data-form="change-pass" class="mapping">
      <label>סיסמה נוכחית<input type="password" name="old" required autocomplete="current-password"></label>
      <label>סיסמה חדשה<input type="password" name="pass" minlength="10" required autocomplete="new-password"></label>
      <label>אימות<input type="password" name="pass2" minlength="10" required autocomplete="new-password"></label>
      <button class="primary" type="submit">החלפה</button>
    </form>
  </section>
  <section class="card">
    <h2>גיבוי</h2>
    <p class="muted">הנתונים קיימים רק בדפדפן הזה – ניקוי נתוני הדפדפן ימחק אותם. הורידו גיבוי מוצפן מדי פעם (אפשר לשמור אותו גם בענן – בלי הסיסמה אי אפשר לקרוא אותו).
    אותו קובץ משמש גם להעברת הנתונים למחשב אחר.</p>
    <button data-action="backup">הורדת גיבוי מוצפן</button>
  </section>
  <section class="card danger">
    <h2>מחיקת כל הנתונים</h2>
    <button data-action="wipe">מחיקת הכספת מהדפדפן</button>
  </section>`);
}

function render() {
  if (!state.data) { renderLock(); return; }
  ({ dashboard: renderDashboard, transactions: renderTransactions, import: renderImport, rules: renderRules, settings: renderSettings }[state.view] || renderDashboard)();
}

// Apply CSSOM-only styling (CSP forbids inline style attributes).
function hydrate() {
  document.querySelectorAll('[data-w]').forEach(el => { el.style.width = `${el.dataset.w}%`; });
}

// ---------- import ----------

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.html,.htm';
const SUPPORTED = /\.(csv|tsv|txt|xlsx|xls|html?)$/i;

async function addFiles(files) {
  const all = [...files];
  // Folders bring along unrelated files (.DS_Store, PDFs, images...): keep statements only.
  const usable = all.filter(f => SUPPORTED.test(f.name) && !f.name.startsWith('.'));
  if (!usable.length) {
    flash(all.length ? 'לא נמצאו קבצי תדפיס נתמכים (xlsx / xls / csv)' : 'לא נבחרו קבצים', true);
    return;
  }
  flash(`מעבד ${usable.length} קבצים…`);
  for (const file of usable) {
    try {
      const rows = await readFileRows(file.name, await file.arrayBuffer());
      const found = findHeaderRow(rows);
      if (!rows.length) throw new Error('empty');
      const headerRow = Math.max(0, found);
      const map = detectColumns(rows[headerRow]);
      state.pending.push({
        fileName: file.webkitRelativePath || file.name, rows, headerRow, map, invert: map.invert,
        account: file.name.replace(/\.[^.]+$/, ''),
      });
    } catch (e) {
      const msg = {
        'xls-binary': 'קובץ Excel בפורמט ישן (xls). פתחו אותו ב-Excel ושמרו כ-xlsx או CSV.',
        pdf: 'קבצי PDF אינם נתמכים. הורידו מאתר הבנק את התנועות כקובץ Excel או CSV.',
        empty: 'הקובץ ריק.',
      }[e.message] || `שגיאה בקריאת הקובץ (${e.message})`;
      state.pending.push({ fileName: file.name, error: msg });
    }
  }
  state.view = 'import';
  render();
  document.getElementById('pending')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const skipped = all.length - usable.length;
  flash(`${usable.length} קבצים מוכנים – בדקו ולחצו "ייבוא"${skipped ? ` (${skipped} קבצים אחרים דולגו)` : ''}`);
}

function importOne(p) {
  const parsed = pendingPreview(p);
  const existing = new Set(txs().map(t => t.fp));
  const seen = new Map();
  const importId = crypto.randomUUID();
  let added = 0, dup = 0;
  for (const t of parsed) {
    const base = `${t.date}|${t.amount}|${normalizeDesc(t.description)}|${p.account}`;
    const n = (seen.get(base) || 0) + 1; // identical rows within one file are legitimate
    seen.set(base, n);
    const fp = `${base}#${n}`;
    if (existing.has(fp)) { dup++; continue; }
    txs().push(classify({
      id: crypto.randomUUID(), fp, importId, ...t, account: p.account, event: '', manual: false,
    }, state.data.rules));
    added++;
  }
  state.data.imports.push({ id: importId, fileName: p.fileName, account: p.account, date: new Date().toISOString(), count: added });
  return { added, dup };
}

function finishImport(added, dup) {
  persist();
  if (!state.pending.length) state.view = 'dashboard';
  render();
  window.scrollTo(0, 0);
  flash(`יובאו ${added} תנועות${dup ? `, ${dup} כפולות דולגו` : ''}`);
}

function importPending(i) {
  const { added, dup } = importOne(state.pending[i]);
  state.pending.splice(i, 1);
  finishImport(added, dup);
}

function importAllPending() {
  let added = 0, dup = 0;
  for (const p of state.pending.filter(x => !x.error && pendingPreview(x).length)) {
    const r = importOne(p);
    added += r.added; dup += r.dup;
    p.done = true;
  }
  state.pending = state.pending.filter(p => !p.done);
  finishImport(added, dup);
}

// Recursively collect files from a dropped folder.
async function entryFiles(entry) {
  if (entry.isFile) return [await new Promise((res, rej) => entry.file(res, rej))];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const entries = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    entries.push(...batch);
  }
  return (await Promise.all(entries.map(entryFiles))).flat();
}

// ---------- events ----------

document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;
  const btn = form.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try {
    if (kind === 'create') {
      if (fd.pass !== fd.pass2) throw new Error('הסיסמאות אינן תואמות');
      const data = store.emptyData();
      data.rules = defaultRules();
      state.session = await store.createVault(fd.pass, data);
      state.data = data;
      state.view = 'import';
      render();
    } else if (kind === 'unlock') {
      const { session, data } = await store.unlockVault(fd.pass);
      if (!data.rules) data.rules = defaultRules();
      data.settings ||= { autoLockMinutes: 15 };
      state.session = session; state.data = data; state.view = 'dashboard';
      state.lastActivity = Date.now();
      render();
    } else if (kind === 'add-rule') {
      state.data.rules.unshift({ id: crypto.randomUUID(), match: fd.match.trim(), category: fd.category.trim(), kind: fd.kind });
      reclassifyAll(); persist(); render();
    } else if (kind === 'change-pass') {
      if (fd.pass !== fd.pass2) throw new Error('הסיסמאות אינן תואמות');
      await store.unlockVault(fd.old); // verifies the current passphrase
      state.session = await store.createVault(fd.pass, state.data);
      flash('הסיסמה הוחלפה'); form.reset();
    }
  } catch (err) {
    const text = err.message === 'bad-passphrase' ? 'סיסמה שגויה' : err.message;
    if (state.data) flash(text, true);
    else { const el = $('#lock-error'); if (el) el.textContent = text; }
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  const row = el.closest('tr[data-id]');
  const tx = row && txs().find(t => t.id === row.dataset.id);

  switch (act) {
    case 'nav': state.view = el.dataset.view; render(); window.scrollTo(0, 0); break;
    case 'lock': lock(); break;
    case 'more': state.filters.limit += 300; render(); break;
    case 'show-uncategorized':
      state.filters = { month: '', kind: '', category: '__none', q: '', limit: 200 };
      state.view = 'transactions'; render(); break;
    case 'filter-category':
      state.filters = { month: '', kind: '', category: el.dataset.category, q: '', limit: 200 };
      state.view = 'transactions'; render(); break;
    case 'make-fixed': {
      state.data.rules.unshift({ id: crypto.randomUUID(), match: el.dataset.key, category: el.dataset.category || 'אחר', kind: 'fixed' });
      reclassifyAll(); persist(); render(); flash('נוצר כלל: ' + el.dataset.key);
      break;
    }
    case 'make-rule': {
      if (!tx) break;
      const suggestion = normalizeDesc(tx.description).split(' ').slice(0, 3).join(' ');
      const match = prompt('כל תנועה שהתיאור שלה מכיל את הטקסט הבא תסווג כמו התנועה הזו:', suggestion);
      if (!match || !match.trim()) break;
      state.data.rules.unshift({ id: crypto.randomUUID(), match: match.trim(), category: tx.category, kind: tx.kind });
      reclassifyAll(); persist(); render(); flash('הכלל נוסף והוחל');
      break;
    }
    case 'delete-tx':
      if (tx && confirm(`למחוק את התנועה "${tx.description}"?`)) {
        state.data.transactions = txs().filter(t => t !== tx); persist(); render();
      }
      break;
    case 'drop-pending': state.pending.splice(Number(el.dataset.i), 1); render(); break;
    case 'confirm-import': importPending(Number(el.dataset.i)); break;
    case 'import-all': importAllPending(); break;
    case 'drop-all': state.pending = []; render(); break;
    case 'delete-import': {
      const im = state.data.imports.find(x => x.id === el.dataset.id);
      if (im && confirm(`למחוק את ${im.count} התנועות שיובאו מ-"${im.fileName}"?`)) {
        state.data.transactions = txs().filter(t => t.importId !== im.id);
        state.data.imports = state.data.imports.filter(x => x !== im);
        persist(); render();
      }
      break;
    }
    case 'reapply': reclassifyAll(); persist(); render(); flash('הכללים הוחלו'); break;
    case 'reset-rules':
      if (confirm('להחליף את כל הכללים בכללי ברירת המחדל?')) { state.data.rules = defaultRules(); reclassifyAll(); persist(); render(); }
      break;
    case 'rule-up': case 'delete-rule': {
      const rules = state.data.rules;
      const idx = rules.findIndex(r => r.id === el.closest('tr').dataset.rule);
      if (idx < 0) break;
      if (act === 'delete-rule') rules.splice(idx, 1);
      else if (idx > 0) [rules[idx - 1], rules[idx]] = [rules[idx], rules[idx - 1]];
      reclassifyAll(); persist(); render();
      break;
    }
    case 'backup': {
      clearTimeout(saveTimer);
      await store.saveVault(state.session, state.data);
      const rec = await store.readRecord();
      download(`family-budget-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(rec));
      break;
    }
    case 'wipe':
      if (confirm('למחוק לצמיתות את כל הנתונים מהדפדפן? (גיבוי שהורדתם לא יימחק)')
        && prompt('הקלידו "מחק" לאישור') === 'מחק') {
        await store.deleteRecord(); lock();
      }
      break;
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  const row = el.closest('tr[data-id]');
  if (el.dataset.edit && row) {
    const tx = txs().find(t => t.id === row.dataset.id);
    if (!tx) return;
    tx[el.dataset.edit] = el.value.trim();
    if (el.dataset.edit !== 'event') tx.manual = true;
    if (el.dataset.edit === 'event' && tx.event && tx.kind !== 'oneoff') { tx.kind = 'oneoff'; tx.manual = true; render(); }
    persist();
    return;
  }
  if (el.dataset.pending !== undefined) {
    const p = state.pending[Number(el.dataset.pending)];
    const f = el.dataset.field;
    if (f === 'headerRow') {
      p.headerRow = Math.max(0, Math.min(p.rows.length - 1, Number(el.value) - 1));
      const m = detectColumns(p.rows[p.headerRow]);
      p.map = m; p.invert = m.invert;
    } else if (f === 'invert') p.invert = el.checked;
    else if (f === 'account') p.account = el.value.trim();
    else p.map[f] = Number(el.value);
    render();
    return;
  }
  if (el.dataset.filter) {
    state.filters[el.dataset.filter] = el.value;
    state.filters.limit = 200;
    render();
    const again = document.querySelector(`[data-filter="${el.dataset.filter}"]`);
    if (again && el.dataset.filter === 'q') { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    return;
  }
  switch (el.dataset.change) {
    case 'period': state.period = el.value; render(); break;
    case 'files': await addFiles([...el.files]); break;
    case 'autolock': state.data.settings.autoLockMinutes = Math.max(1, Number(el.value) || 15); persist(); break;
    case 'restore-file': {
      const file = el.files[0];
      if (!file) break;
      try {
        const rec = JSON.parse(await file.text());
        if (!store.isVaultRecord(rec)) throw new Error();
        if ((await store.hasVault()) && !confirm('לדרוס את הנתונים השמורים בדפדפן בגיבוי?')) break;
        await store.restoreRecord(rec);
        state.message = 'הגיבוי נטען. הזינו את הסיסמה של הגיבוי.';
      } catch {
        state.message = 'הקובץ אינו גיבוי תקין.';
      }
      render();
      break;
    }
  }
});

// Live search without losing focus on every keystroke.
let searchTimer;
document.addEventListener('input', e => {
  if (e.target.dataset.filter !== 'q') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => e.target.dispatchEvent(new Event('change', { bubbles: true })), 350);
});

// Drag & drop statements.
document.addEventListener('dragover', e => {
  if (e.target.closest('[data-drop]')) { e.preventDefault(); e.target.closest('[data-drop]').classList.add('over'); }
});
document.addEventListener('dragleave', e => e.target.closest?.('[data-drop]')?.classList.remove('over'));
document.addEventListener('drop', e => {
  const zone = e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('over');
  // Entries must be taken synchronously, before the drop event ends.
  const entries = [...(e.dataTransfer.items || [])].map(it => it.webkitGetAsEntry?.()).filter(Boolean);
  const plain = [...e.dataTransfer.files];
  (entries.length ? Promise.all(entries.map(entryFiles)).then(r => r.flat()) : Promise.resolve(plain))
    .then(addFiles, () => addFiles(plain));
});

// Tooltips for chart hit targets.
const tip = $('#tip');
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
});
document.addEventListener('mousemove', e => {
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

render();
