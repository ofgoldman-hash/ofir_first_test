// OTP login core: phone allowlist, signed session cookies and Twilio Verify calls.
// Runtime-agnostic (Web APIs only) so it runs in Edge (Deno), Functions (Node) and tests.

export const SESSION_COOKIE = 'fb_session';
export const SESSION_DAYS = 7;

export interface PhoneEntry {
  phone: string;       // E.164, e.g. +972536067630
  name: string;
  admin: boolean;
  addedAt: string;
  addedBy?: string;
}

export interface AuthState {
  secret: string;
  phones: PhoneEntry[];
}

// Minimal subset of the Netlify Blobs store API that we use.
export interface KV {
  get(key: string, opts: { type: 'json' }): Promise<any>;
  setJSON(key: string, value: unknown): Promise<void>;
}

export interface Env {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  ADMIN_PHONE?: string;
}

// ---------- phones ----------

// Accepts Israeli local numbers (0536067630), +972..., 972... and other E.164 numbers.
export function normalizePhone(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (/^0\d{8,9}$/.test(digits)) digits = '+972' + digits.slice(1);
  else if (/^972\d{8,9}$/.test(digits)) digits = '+' + digits;
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 4)}•••${phone.slice(-3)}` : '•••';
}

// The ADMIN_PHONE env var is always allowed and always an admin, so the owner can't lock themselves out.
export function effectivePhones(state: AuthState, env: Env): PhoneEntry[] {
  const owner = normalizePhone(env.ADMIN_PHONE);
  const list = state.phones.filter(p => p.phone !== owner);
  return owner
    ? [{ phone: owner, name: 'בעל האתר', admin: true, addedAt: '', addedBy: 'ADMIN_PHONE' }, ...list]
    : list;
}

export function findPhone(state: AuthState, env: Env, phone: string | null): PhoneEntry | null {
  if (!phone) return null;
  return effectivePhones(state, env).find(p => p.phone === phone) || null;
}

// ---------- state in Blobs ----------

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

export async function loadState(store: KV): Promise<AuthState> {
  let secret = await store.get('session-secret', { type: 'json' });
  if (!secret?.value) {
    // Generated server-side on first use; never leaves Netlify.
    secret = { value: b64url(crypto.getRandomValues(new Uint8Array(32))) };
    await store.setJSON('session-secret', secret);
  }
  const phones = (await store.get('phones', { type: 'json' }))?.phones || [];
  return { secret: secret.value, phones };
}

export async function savePhones(store: KV, phones: PhoneEntry[]): Promise<void> {
  await store.setJSON('phones', { phones });
}

// ---------- sessions ----------

async function hmacKey(secret: string, usage: KeyUsage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signSession(secret: string, phone: string, now = Date.now()): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ p: phone, e: now + SESSION_DAYS * 86400000 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

// Returns the phone for a valid, unexpired token, else null. crypto.subtle.verify is constant-time.
export async function verifySession(secret: string, token: string | undefined | null, now = Date.now()): Promise<string | null> {
  if (!token || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
  const [payload, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromB64url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const { p, e } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof p === 'string' && typeof e === 'number' && e > now ? p : null;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name = SESSION_COOKIE): string | null {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// Resolves the logged-in, still-authorised user of a request.
export async function currentUser(req: Request, state: AuthState, env: Env): Promise<PhoneEntry | null> {
  return findPhone(state, env, await verifySession(state.secret, readCookie(req)));
}

// ---------- Twilio Verify ----------

type Fetch = typeof fetch;

function twilio(env: Env, fetchFn: Fetch, path: string, form: Record<string, string>) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_VERIFY_SERVICE_SID: service } = env;
  if (!sid || !token || !service) throw new Error('twilio-not-configured');
  return fetchFn(`https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
}

export async function sendCode(env: Env, fetchFn: Fetch, phone: string): Promise<boolean> {
  const res = await twilio(env, fetchFn, 'Verifications', { To: phone, Channel: 'sms', Locale: 'he' });
  return res.ok;
}

export async function checkCode(env: Env, fetchFn: Fetch, phone: string, code: string): Promise<boolean> {
  if (!/^\d{4,10}$/.test(code)) return false;
  const res = await twilio(env, fetchFn, 'VerificationCheck', { To: phone, Code: code });
  if (!res.ok) return false; // 404 = expired / too many attempts
  const body = await res.json();
  return body?.status === 'approved';
}

// ---------- HTTP helpers ----------

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Robots-Tag': 'noindex, nofollow',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra },
  });
}

// Blocks cross-site form/fetch posts (on top of SameSite=Strict cookies).
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return !origin || origin === new URL(req.url).origin;
}
