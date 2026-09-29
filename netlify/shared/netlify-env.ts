// Netlify-specific wiring: Blobs store and environment variables.
import { getStore, getDeployStore } from '@netlify/blobs';
import type { Deps } from './handlers.ts';
import type { Env, KV } from './auth.ts';

declare const Netlify: { env: { get(key: string): string | undefined } };

// The part of the Functions / Edge Functions context argument we need.
export interface DeployContext { deploy?: { context?: string } }

// Production data stays separate from deploy previews (per Netlify Blobs guidance).
// The deploy context comes from the handler's context argument, which both the
// edge gate and the functions receive, so they always use the same store.
export function authStore(context: DeployContext): KV {
  const production = context.deploy?.context === 'production';
  return (production
    ? getStore({ name: 'auth', consistency: 'strong' })
    : getDeployStore({ name: 'auth' })) as unknown as KV;
}

export function env(): Env {
  const get = (k: string) => Netlify.env.get(k);
  return {
    TWILIO_ACCOUNT_SID: get('TWILIO_ACCOUNT_SID'),
    TWILIO_AUTH_TOKEN: get('TWILIO_AUTH_TOKEN'),
    TWILIO_VERIFY_SERVICE_SID: get('TWILIO_VERIFY_SERVICE_SID'),
    ADMIN_PHONE: get('ADMIN_PHONE'),
  };
}

export function deps(context: DeployContext): Deps {
  return { store: authStore(context), env: env(), fetch };
}
