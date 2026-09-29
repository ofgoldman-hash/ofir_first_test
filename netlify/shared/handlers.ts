// Request handlers with injected dependencies (store, env, fetch) so they can be unit-tested.
import {
  type Env, type KV, type PhoneEntry,
  loadState, savePhones, normalizePhone, findPhone, effectivePhones, currentUser,
  sendCode, checkCode, signSession, sessionCookie, clearCookie, json, sameOrigin,
} from './auth.ts';

export interface Deps {
  store: KV;
  env: Env;
  fetch: typeof fetch;
}

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

// Same answer whether or not the number is allowed, so the allowlist can't be probed.
const SENT = { ok: true, message: 'אם המספר מורשה, נשלח אליו קוד ב-SMS.' };

export async function handleSend(req: Request, { store, env, fetch }: Deps): Promise<Response> {
  if (req.method !== 'POST' || !sameOrigin(req)) return json({ error: 'bad-request' }, 400);
  const phone = normalizePhone((await body(req)).phone);
  if (!phone) return json({ error: 'invalid-phone', message: 'מספר טלפון לא תקין' }, 400);
  const state = await loadState(store);
  // Only allowlisted numbers ever trigger an SMS (prevents SMS pumping / cost abuse).
  if (findPhone(state, env, phone)) {
    try {
      if (!(await sendCode(env, fetch, phone))) return json({ error: 'send-failed', message: 'שליחת ה-SMS נכשלה. נסו שוב בעוד מספר דקות.' }, 502);
    } catch (e) {
      if ((e as Error).message === 'twilio-not-configured') return json({ error: 'not-configured', message: 'שירות ה-SMS עדיין לא הוגדר באתר.' }, 503);
      throw e;
    }
  }
  return json(SENT);
}

export async function handleVerify(req: Request, { store, env, fetch }: Deps): Promise<Response> {
  if (req.method !== 'POST' || !sameOrigin(req)) return json({ error: 'bad-request' }, 400);
  const data = await body(req);
  const phone = normalizePhone(data.phone);
  const code = String(data.code ?? '').replace(/\D/g, '');
  const state = await loadState(store);
  const fail = json({ error: 'invalid-code', message: 'הקוד שגוי או שפג תוקפו.' }, 401);
  if (!phone || !findPhone(state, env, phone)) return fail;
  if (!(await checkCode(env, fetch, phone, code))) return fail;
  const token = await signSession(state.secret, phone);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

export function handleLogout(): Response {
  return new Response(null, { status: 303, headers: { Location: '/login.html', 'Set-Cookie': clearCookie(), 'Cache-Control': 'no-store' } });
}

const publicEntry = (p: PhoneEntry, owner: string | null) => ({ ...p, locked: p.phone === owner });

export async function handleAdmin(req: Request, { store, env }: Deps): Promise<Response> {
  const state = await loadState(store);
  const me = await currentUser(req, state, env);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (!me.admin) return json({ error: 'forbidden', message: 'רק מנהלים יכולים לנהל מספרים.' }, 403);
  const owner = normalizePhone(env.ADMIN_PHONE);

  if (req.method === 'GET') {
    return json({ me: me.phone, phones: effectivePhones(state, env).map(p => publicEntry(p, owner)) });
  }
  if (!sameOrigin(req)) return json({ error: 'bad-origin' }, 403);

  const data = await body(req);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ error: 'invalid-phone', message: 'מספר טלפון לא תקין' }, 400);
  const others = state.phones.filter(p => p.phone !== phone);

  if (req.method === 'POST') {
    if (phone === owner) return json({ error: 'locked', message: 'זה מספר בעל האתר – הוא תמיד מורשה.' }, 400);
    const entry: PhoneEntry = {
      phone,
      name: String(data.name ?? '').trim().slice(0, 60),
      admin: data.admin === true,
      addedAt: new Date().toISOString(),
      addedBy: me.phone,
    };
    await savePhones(store, [...others, entry]);
    return json({ ok: true, phone: publicEntry(entry, owner) });
  }
  if (req.method === 'DELETE') {
    if (phone === owner) return json({ error: 'locked', message: 'אי אפשר להסיר את מספר בעל האתר.' }, 400);
    if (phone === me.phone) return json({ error: 'self', message: 'אי אפשר להסיר את המספר שלך.' }, 400);
    await savePhones(store, others);
    return json({ ok: true });
  }
  return json({ error: 'method-not-allowed' }, 405);
}

// Decides what the edge gate does with a request: null = let it through.
export async function gateCheck(req: Request, { store, env }: Pick<Deps, 'store' | 'env'>): Promise<Response | null> {
  const url = new URL(req.url);
  const user = await currentUser(req, await loadState(store), env);
  if (!user) {
    const wantsPage = req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html');
    if (!wantsPage) return new Response('Unauthorized', { status: 401 });
    const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
    return new Response(null, { status: 302, headers: { Location: `/login.html${next}` } });
  }
  if (url.pathname.startsWith('/admin') && !user.admin) return new Response('Forbidden', { status: 403 });
  return null;
}
