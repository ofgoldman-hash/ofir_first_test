// Runs before every page and file: only logged-in, allowlisted phones get the site.
import type { Config, Context } from '@netlify/edge-functions';
import { SECURITY_HEADERS } from '../shared/auth.ts';
import { gateCheck } from '../shared/handlers.ts';
import { authStore, env } from '../shared/netlify-env.ts';

function withHeaders(res: Response): Response {
  // Edge-served paths don't receive netlify.toml headers, so add them here.
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  out.headers.set('Cache-Control', 'no-store');
  return out;
}

export default async (req: Request, context: Context) => {
  const blocked = await gateCheck(req, { store: authStore(context), env: env() });
  return withHeaders(blocked ?? await context.next());
};

export const config: Config = {
  path: '/*',
  // The login page and its assets must stay reachable; APIs check the session themselves.
  excludedPath: ['/login.html', '/js/login.js', '/css/style.css', '/api/*', '/favicon.ico'],
};
