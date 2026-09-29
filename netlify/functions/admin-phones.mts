import type { Config, Context } from '@netlify/functions';
import { handleAdmin } from '../shared/handlers.ts';
import { deps } from '../shared/netlify-env.ts';

export default async (req: Request, context: Context) => handleAdmin(req, deps(context));

export const config: Config = { path: '/api/admin/phones' };
