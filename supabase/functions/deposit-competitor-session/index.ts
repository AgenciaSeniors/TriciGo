// ============================================================
// TriciGo — deposit-competitor-session
//
// The owner's phone (the "key" in the A+C architecture) deposits a fresh session
// credential for a competitor so track-competitor-prices can quote as a logged-in
// user. Writes the competitor_sessions lock table (which nothing else can read or
// write via PostgREST).
//
// Auth: this is NOT open. It authenticates the caller (auth.getUser) and requires
// an admin/super_admin role — only the owner deposits credentials. That is why it
// canNOT be a plain verify_jwt=false endpoint the way the cron-only EF is.
//
// Why store the raw credential at all (vs the project's "derive, don't store"
// precedent, mint-netopia-proxy-credential): that HMAC precedent works because the
// credential is OURS. A competitor session is a third party's, issued only by their
// server — it cannot be derived, only captured and kept. The lock table is already
// unreadable via PostgREST; encrypting at rest with Vault is a possible later hardening.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const VALID_COMPETITORS = new Set(['la_nave', 'cinco']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';

    // Authenticate the caller from their bearer token.
    const authHeader = req.headers.get('Authorization') ?? '';
    const asUser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await asUser.auth.getUser();
    if (userErr || !userData?.user) return json({ error: 'unauthenticated' }, 401);

    // Require admin/super_admin.
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await admin.from('users').select('role').eq('id', userData.user.id).maybeSingle();
    const role = profile?.role ?? '';
    if (role !== 'admin' && role !== 'super_admin') return json({ error: 'forbidden' }, 403);

    const body = await req.json().catch(() => null);
    const competitor = body?.competitor;
    const credential = body?.credential;
    const expiresAt = body?.expires_at ?? null;
    if (!VALID_COMPETITORS.has(competitor)) return json({ error: 'invalid_competitor' }, 400);
    if (typeof credential !== 'string' || credential.length < 8) return json({ error: 'invalid_credential' }, 400);

    const { error: upErr } = await admin.from('competitor_sessions').upsert({
      competitor,
      credential,
      expires_at: expiresAt,
      status: 'unknown',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'competitor' });
    if (upErr) return json({ error: 'store_failed', detail: upErr.message }, 500);

    return json({ ok: true, competitor }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: 'unhandled', detail: msg }, 500);
  }
});
