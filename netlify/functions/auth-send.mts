import type { Config, Context } from '@netlify/functions';
import { handleSend } from '../shared/handlers.ts';
import { deps } from '../shared/netlify-env.ts';

export default async (req: Request, context: Context) => handleSend(req, deps(context));

export const config: Config = { path: '/api/auth/send' };
