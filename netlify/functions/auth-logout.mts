import type { Config, Context } from '@netlify/functions';
import { handleLogout } from '../shared/handlers.ts';

export default async (_req: Request, _context: Context) => handleLogout();

export const config: Config = { path: '/api/auth/logout' };
