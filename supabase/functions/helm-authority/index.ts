/**
 * helm-authority — the trusted authority service (ADR-0024), as a Supabase
 * edge function.
 *
 *   POST { op: 'evaluate', orgId, commitmentId }
 *   POST { op: 'approve' | 'reject' | 'return', orgId, requiredApprovalId, comments, conditions?, validUntil? }
 *
 * The caller's JWT is verified by Supabase Auth; the verdict is computed from
 * HELM's own records by the kernel in ./kernel.mjs (built from
 * server/authority/host.ts by `npm run build:authority-function`) and written
 * with the service role — the only role that may write authority records.
 * Deploy with verify_jwt enabled.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleAuthorityRequest } from './kernel.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
/** The two Deno globals this function uses, typed here so the file needs no Deno types. */
type DenoHost = {
  serve: (handler: (req: Request) => Promise<Response>) => unknown;
  env: { get: (name: string) => string | undefined };
};
const deno = (globalThis as unknown as { Deno: DenoHost }).Deno;
const required = (name: string): string => {
  const value = deno.env.get(name);
  if (!value) throw new Error(`helm-authority: ${name} is not set.`);
  return value;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, error: { code: 'authority.method', message: 'POST only.' } });
  const url = required('SUPABASE_URL');
  const anonKey = required('SUPABASE_ANON_KEY');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = req.headers.get('Authorization') ?? '';
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await caller.auth.getUser();
  const identity = data?.user ? { userId: data.user.id } : null;
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const res = await handleAuthorityRequest({ service, caller }, identity, body);
  return json(res.status, res.body);
});
