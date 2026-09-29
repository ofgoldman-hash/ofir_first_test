import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, signSession, verifySession, loadState, SESSION_COOKIE } from '../netlify/shared/auth.ts';
import { handleSend, handleVerify, handleAdmin, handleLogout } from '../netlify/shared/handlers.ts';

const OWNER = '+972536067630';
const ORIGIN = 'https://family-budget-ofir.netlify.app';

function memoryStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
  };
}

// Fake Twilio Verify: records sent SMS, approves code 123456.
function fakeTwilio() {
  const calls = [];
  const fetchFn = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, form, auth: init.headers.Authorization });
    if (url.endsWith('/Verifications')) return new Response('{}', { status: 201 });
    return new Response(JSON.stringify({ status: form.Code === '123456' ? 'approved' : 'pending' }), { status: 200 });
  };
  return { calls, fetch: fetchFn };
}

const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_VERIFY_SERVICE_SID: 'VA1', ADMIN_PHONE: '0536067630' };
const post = (path, body, headers = {}) => new Request(ORIGIN + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body),
});
const cookieFrom = res => res.headers.get('set-cookie').split(';')[0];

async function login(deps, phone) {
  await handleSend(post('/api/auth/send', { phone }), deps);
  return cookieFrom(await handleVerify(post('/api/auth/verify', { phone, code: '123456' }), deps));
}

test('normalizePhone handles Israeli formats', () => {
  assert.equal(normalizePhone('0536067630'), OWNER);
  assert.equal(normalizePhone('053-606-7630'), OWNER);
  assert.equal(normalizePhone('+972 53 606 7630'), OWNER);
  assert.equal(normalizePhone('972536067630'), OWNER);
  assert.equal(normalizePhone('00972536067630'), OWNER);
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone(''), null);
});

test('session tokens: valid, tampered, expired, wrong secret', async () => {
  const t = await signSession('s1', OWNER, 1000);
  assert.equal(await verifySession('s1', t, 2000), OWNER);
  assert.equal(await verifySession('s2', t, 2000), null);
  assert.equal(await verifySession('s1', t, 1000 + 8 * 86400000), null);
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ p: '+972500000000', e: 9e15 })).toString('base64url');
  assert.equal(await verifySession('s1', `${forged}.${s}`, 2000), null);
  assert.equal(await verifySession('s1', 'garbage', 2000), null);
  assert.ok(p);
});

test('secret is generated once and reused', async () => {
  const store = memoryStore();
  const a = await loadState(store);
  const b = await loadState(store);
  assert.equal(a.secret, b.secret);
  assert.ok(a.secret.length >= 40);
});

test('only allowlisted numbers get an SMS, with the same response either way', async () => {
  const tw = fakeTwilio();
  const deps = { store: memoryStore(), env, fetch: tw.fetch };
  const allowed = await handleSend(post('/api/auth/send', { phone: '0536067630' }), deps);
  const stranger = await handleSend(post('/api/auth/send', { phone: '0521111111' }), deps);
  assert.equal(allowed.status, 200);
  assert.equal(stranger.status, 200);
  assert.deepEqual(await allowed.json(), await stranger.json());
  assert.equal(tw.calls.length, 1);
  assert.equal(tw.calls[0].url, 'https://verify.twilio.com/v2/Services/VA1/Verifications');
  assert.deepEqual(tw.calls[0].form, { To: OWNER, Channel: 'sms', Locale: 'he' });
  assert.equal(tw.calls[0].auth, 'Basic ' + btoa('AC1:tok'));
});

test('cross-site requests and bad numbers are rejected', async () => {
  const deps = { store: memoryStore(), env, fetch: fakeTwilio().fetch };
  assert.equal((await handleSend(post('/api/auth/send', { phone: '0536067630' }, { Origin: 'https://evil.example' }), deps)).status, 400);
  assert.equal((await handleSend(post('/api/auth/send', { phone: 'abc' }), deps)).status, 400);
});

test('missing Twilio configuration gives a clear error', async () => {
  const deps = { store: memoryStore(), env: { ADMIN_PHONE: OWNER }, fetch: fakeTwilio().fetch };
  const res = await handleSend(post('/api/auth/send', { phone: OWNER }), deps);
  assert.equal(res.status, 503);
});

test('verify: wrong code fails, right code sets a secure session cookie', async () => {
  const deps = { store: memoryStore(), env, fetch: fakeTwilio().fetch };
  const bad = await handleVerify(post('/api/auth/verify', { phone: OWNER, code: '000000' }), deps);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  const ok = await handleVerify(post('/api/auth/verify', { phone: '0536067630', code: '123456' }), deps);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), flag);
  // A number that's not allowlisted can't log in even with a "valid" code.
  const stranger = await handleVerify(post('/api/auth/verify', { phone: '0521111111', code: '123456' }), deps);
  assert.equal(stranger.status, 401);
});

test('admin: owner adds and removes a number; removed number loses access immediately', async () => {
  const deps = { store: memoryStore(), env, fetch: fakeTwilio().fetch };
  const owner = await login(deps, '0536067630');
  const as = (cookie, method, body) => new Request(ORIGIN + '/api/admin/phones', {
    method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });

  let list = await (await handleAdmin(as(owner, 'GET'), deps)).json();
  assert.deepEqual(list.phones.map(p => [p.phone, p.admin, p.locked]), [[OWNER, true, true]]);

  assert.equal((await handleAdmin(as(owner, 'POST', { phone: '052-111-1111', name: 'בן זוג' }), deps)).status, 200);
  list = await (await handleAdmin(as(owner, 'GET'), deps)).json();
  assert.deepEqual(list.phones.map(p => p.phone), [OWNER, '+972521111111']);

  const partner = await login(deps, '0521111111');
  // A regular user can't manage numbers.
  assert.equal((await handleAdmin(as(partner, 'GET'), deps)).status, 403);
  // The owner can't be removed.
  assert.equal((await handleAdmin(as(owner, 'DELETE', { phone: OWNER }), deps)).status, 400);

  assert.equal((await handleAdmin(as(owner, 'DELETE', { phone: '0521111111' }), deps)).status, 200);
  assert.equal((await handleAdmin(as(partner, 'GET'), deps)).status, 401);
  // No cookie at all.
  assert.equal((await handleAdmin(new Request(ORIGIN + '/api/admin/phones'), deps)).status, 401);
});

test('logout clears the cookie', () => {
  const res = handleLogout();
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

test('gate: redirects pages to login, 401 for files, admin page for admins only', async () => {
  const { gateCheck } = await import('../netlify/shared/handlers.ts');
  const deps = { store: memoryStore(), env, fetch: fakeTwilio().fetch };
  const page = (path, cookie) => new Request(ORIGIN + path, { headers: { Accept: 'text/html', ...(cookie ? { Cookie: cookie } : {}) } });

  let res = await gateCheck(page('/'), deps);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login.html');
  res = await gateCheck(page('/admin.html'), deps);
  assert.equal(res.headers.get('location'), '/login.html?next=%2Fadmin.html');
  res = await gateCheck(new Request(ORIGIN + '/js/app.js'), deps);
  assert.equal(res.status, 401);
  res = await gateCheck(page('/', `${SESSION_COOKIE}=forged.token`), deps);
  assert.equal(res.status, 302);

  const owner = await login(deps, OWNER);
  assert.equal(await gateCheck(page('/', owner), deps), null);
  assert.equal(await gateCheck(page('/admin.html', owner), deps), null);

  const store = deps.store;
  await store.setJSON('phones', { phones: [{ phone: '+972521111111', name: '', admin: false, addedAt: '' }] });
  const user = await login(deps, '0521111111');
  assert.equal(await gateCheck(page('/', user), deps), null);
  assert.equal((await gateCheck(page('/admin.html', user), deps)).status, 403);
});
