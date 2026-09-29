import { esc } from './format.js';

const $ = s => document.querySelector(s);
const errorEl = $('#error');

async function api(method, data) {
  const res = await fetch('/api/admin/phones', {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
    body: data ? JSON.stringify(data) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html?next=/admin.html'; return null; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || 'הפעולה נכשלה');
  return body;
}

const displayPhone = p => p.startsWith('+972') ? '0' + p.slice(4) : p;

async function load() {
  const data = await api('GET');
  if (!data) return;
  $('#rows').innerHTML = data.phones.map(p => `<tr>
    <td dir="ltr">${esc(displayPhone(p.phone))}${p.phone === data.me ? ' <span class="badge">(את/ה)</span>' : ''}</td>
    <td>${esc(p.name)}</td>
    <td>${p.admin ? 'מנהל' : 'משתמש'}</td>
    <td>${p.addedAt ? esc(new Date(p.addedAt).toLocaleDateString('he-IL')) : '—'}</td>
    <td>${p.locked || p.phone === data.me ? '' : `<button data-remove="${esc(p.phone)}">הסרה</button>`}</td>
  </tr>`).join('');
}

$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  errorEl.textContent = '';
  try {
    await api('POST', { phone: f.phone.value, name: f.name.value, admin: f.admin.checked });
    f.reset();
    await load();
  } catch (err) { errorEl.textContent = err.message; }
});

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-remove]');
  if (!btn || !confirm(`להסיר את ${displayPhone(btn.dataset.remove)}? הגישה שלו תיחסם מיד.`)) return;
  try { await api('DELETE', { phone: btn.dataset.remove }); await load(); } catch (err) { errorEl.textContent = err.message; }
});

load().catch(err => { errorEl.textContent = err.message; });
