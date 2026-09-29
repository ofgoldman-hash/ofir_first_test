const $ = s => document.querySelector(s);
const phoneForm = $('#phone-form');
const codeForm = $('#code-form');
const errorEl = $('#error');
let phone = '';

async function post(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

async function submit(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  errorEl.textContent = '';
  try { await fn(); } catch { errorEl.textContent = 'שגיאת תקשורת. נסו שוב.'; } finally { btn.disabled = false; }
}

phoneForm.addEventListener('submit', e => {
  e.preventDefault();
  submit(phoneForm, async () => {
    phone = phoneForm.phone.value;
    const { ok, body } = await post('/api/auth/send', { phone });
    if (!ok) { errorEl.textContent = body.message || 'שליחת הקוד נכשלה.'; return; }
    $('#sent-msg').textContent = body.message;
    phoneForm.hidden = true;
    codeForm.hidden = false;
    codeForm.code.value = '';
    codeForm.code.focus();
  });
});

codeForm.addEventListener('submit', e => {
  e.preventDefault();
  submit(codeForm, async () => {
    const { ok, body } = await post('/api/auth/verify', { phone, code: codeForm.code.value });
    if (!ok) { errorEl.textContent = body.message || 'הקוד שגוי.'; return; }
    const next = new URLSearchParams(location.search).get('next') || '/';
    // Only same-site relative paths, never an external URL.
    location.replace(/^\/(?!\/)/.test(next) ? next : '/');
  });
});

$('#change-phone').addEventListener('click', () => {
  codeForm.hidden = true;
  phoneForm.hidden = false;
  errorEl.textContent = '';
  phoneForm.phone.focus();
});
