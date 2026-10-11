// ============================================================
// supabase/functions/team-digest-unsubscribe/index.ts
//
// Opt-out and opt-in for the team daily digest (00656). The e-mail's footer links to
// tricigo.com/resumen-diario/baja?u=<account>&t=<token>; that page POSTs here
// { u, t, action: 'out' | 'in' } when the person taps the button. Only POST changes anything:
// mail scanners and link previews follow links with GET. The page lives on tricigo.com because an
// Edge Function on the default domain cannot serve HTML, so every answer is JSON with the CORS
// headers of ALLOWED_ORIGINS (tricigo.com is one), errors included, for the page to read them.
// The token is HMAC-SHA256(TEAM_DIGEST_SECRET or the service key, 'team-digest:' + account id),
// checked in constant time, so a link only works for its own account. verify_jwt is off: the
// person may not be signed in. Each client address gets 20 calls an hour. Tokens are never logged.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey } from '../_shared/service-key.ts';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { digestSecret, UUID_RE, verifyUnsubscribeToken } from '../_shared/team-digest.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN_RE = /^[0-9a-f]{64}$/;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const rl = await rateLimit(`team-digest-unsub:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, cors);

    const raw: unknown = await req.json().catch(() => null);
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as {
      u?: unknown;
      t?: unknown;
      action?: unknown;
    };
    const u = typeof body.u === 'string' ? body.u : '';
    const t = typeof body.t === 'string' ? body.t : '';
    const action = body.action;
    if (!UUID_RE.test(u) || !TOKEN_RE.test(t) || (action !== 'out' && action !== 'in')) {
      return json(400, { error: 'bad_request' });
    }

    const serviceKey = getServiceKey();
    const secret = digestSecret((name) => Deno.env.get(name), serviceKey);
    if (!(await verifyUnsubscribeToken(secret, u, t))) return json(403, { error: 'bad_link' });

    const client = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
    const { data, error } = await client.rpc('set_team_digest_optout', { p_user: u, p_out: action === 'out' });
    if (error) {
      console.error('[team-digest-unsubscribe] set_team_digest_optout failed', error.message);
      return json(500, { error: 'internal' });
    }
    if (data !== true) return json(404, { error: 'not_found' });
    return json(200, { ok: true, subscribed: action === 'in' });
  } catch (err) {
    console.error('[team-digest-unsubscribe]', err instanceof Error ? err.message : String(err));
    return json(500, { error: 'internal' });
  }
});
