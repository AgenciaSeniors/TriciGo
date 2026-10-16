// ============================================================
// TriciGo — team-invitation-code (00664)
//
// The second way to accept an admin panel invitation: a 6-digit code sent to
// the invited address. With it the person creates their account, or sets a
// password on the one that has that address, and gets the role.
//   { action: 'send', token }                               -> mails a code
//   { action: 'verify', token, code, password, full_name? } -> account + role
// verify_jwt = false: the caller has no session yet. The SQL functions
// (team_invitation_code_issue / _check, accept_team_invitation_by_code) decide
// everything about the invitation and the account; this function adds the
// per-IP limits, the e-mail through send-email and the GoTrue calls.
// Outcomes answer 200 { result, ... }, so the panel reads them from data.
// Once the check has spent the code, a failure answers try_again (the page
// tells the person to ask for a new code), never a 500.
// The code and the full address never go back to the caller, except the
// address after a right code (the page signs in with it).
// Spec: docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
// ============================================================
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { getServiceKey } from '../_shared/service-key.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN_RE = /^[0-9a-f]{64}$/;
const HOUR_MS = 60 * 60 * 1000;
// A hung send-email must end in send_failed, not in the runtime's own time limit.
const SEND_EMAIL_TIMEOUT_MS = 20_000;
// bcrypt, which GoTrue uses, reads at most 72 bytes; GoTrue refuses a longer password.
const MAX_PASSWORD_BYTES = 72;

// Untyped client, as in send-campaign. ReturnType<typeof createClient> would pin the generics to
// their constraints and reject rpc arguments and update rows on untyped tables.
type Admin = SupabaseClient;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // Allow-Origin echoes the caller's origin, so a cache must not reuse one answer for another.
    Vary: 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// The gateway sets x-forwarded-for; a forged value does not get past it (CLAUDE.md, 2026-10-06).
function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

interface Issued {
  result?: string;
  code?: string;
  email?: string;
  full_name?: string;
  account_exists?: boolean;
  expires_in_s?: number;
  retry_after_s?: number;
}

interface Checked {
  result?: string;
  email?: string;
  role?: string;
  full_name?: string;
  case?: string;
  user_id?: string | null;
  attempts_left?: number;
}

async function send(req: Request, admin: Admin, url: string, key: string, token: string): Promise<Response> {
  const limit = await rateLimit(`team-code-send-ip:${clientIp(req)}`, 10, HOUR_MS);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterMs, corsHeaders(req));

  const { data, error } = await admin.rpc('team_invitation_code_issue', { p_token: token });
  if (error) throw new Error(`issue: ${error.message}`);
  const issued = (data ?? {}) as Issued;
  if (issued.result !== 'issued') {
    return json(req, { result: issued.result ?? 'not_found', retry_after_s: issued.retry_after_s });
  }
  // 'issued' without the code or the address would tell the page a mail went out when none did.
  if (!issued.code || !issued.email) throw new Error('issue: answer without code or address');

  let mailed: Response;
  try {
    mailed = await fetch(`${url}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({
        template: 'team_invitation_code',
        recipient_email: issued.email,
        data: { code: issued.code, email: issued.email },
      }),
      signal: AbortSignal.timeout(SEND_EMAIL_TIMEOUT_MS),
    });
  } catch (err) {
    // TimeoutError when the deadline passed, TypeError for a network failure.
    console.error('[team-invitation-code] send-email call failed:', err instanceof Error ? err.name : 'error');
    return json(req, { result: 'send_failed' });
  }
  if (!mailed.ok) {
    console.error('[team-invitation-code] send-email failed:', mailed.status);
    return json(req, { result: 'send_failed' });
  }
  return json(req, {
    result: 'sent',
    account_exists: issued.account_exists === true,
    expires_in_s: issued.expires_in_s ?? 600,
    invitee_name: issued.full_name ?? '',
  });
}

function gotrueFailure(req: Request, err: { code?: string; message?: string } | null, step: string): Response {
  const code = err?.code ?? '';
  console.error(`[team-invitation-code] ${step} failed:`, code || err?.message || 'no user');
  return json(req, { result: code === 'weak_password' ? 'weak_password' : 'try_again' });
}

async function verify(req: Request, admin: Admin, token: string, body: Record<string, unknown>): Promise<Response> {
  const limit = await rateLimit(`team-code-verify-ip:${clientIp(req)}`, 30, HOUR_MS);
  if (!limit.allowed) return rateLimitResponse(limit.retryAfterMs, corsHeaders(req));

  // Every space goes, not only the ends: a pasted "048 213" must not waste an attempt.
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const fullName = typeof body.full_name === 'string'
    ? body.full_name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()
    : '';
  // Checked before the code: a refused password or name must not spend it.
  if (password.length < 8 || new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return json(req, { result: 'bad_password' });
  }
  if (fullName.length > 80) return json(req, { result: 'bad_name' });

  const { data, error } = await admin.rpc('team_invitation_code_check', { p_token: token, p_code: code });
  if (error) throw new Error(`check: ${error.message}`);
  const checked = (data ?? {}) as Checked;
  if (checked.result !== 'ok') {
    return json(req, { result: checked.result ?? 'not_found', attempts_left: checked.attempts_left });
  }
  if (!checked.email) throw new Error('check: ok without an address');

  // From here the code is spent: whatever fails answers try_again, so the page asks for a new code.
  try {
    return await finish(req, admin, token, checked, checked.email, password, fullName);
  } catch (err) {
    console.error('[team-invitation-code] failed after the code was used:', err instanceof Error ? err.message : String(err));
    return json(req, { result: 'try_again' });
  }
}

// Creates the account or sets its password, then accepts the invitation. Runs after the check
// spent the code, so it answers try_again (or weak_password) instead of throwing.
async function finish(
  req: Request,
  admin: Admin,
  token: string,
  checked: Checked,
  email: string,
  password: string,
  fullName: string,
): Promise<Response> {
  let userId: string;
  if (checked.case === 'new') {
    // The code is already used here: never fail on a missing name, fall back to the invitation's.
    const name = fullName || (checked.full_name ?? '').trim();
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (createErr || !created?.user) return gotrueFailure(req, createErr, 'create');
    userId = created.user.id;
  } else if (checked.case === 'proven' || checked.case === 'password_only') {
    // A case for an existing account always comes with its id; without it the answer is broken.
    if (!checked.user_id) {
      console.error(`[team-invitation-code] check answered ${checked.case} without an account id`);
      return json(req, { result: 'try_again' });
    }
    // Mark the password as chosen BEFORE writing it: verify-otp (phone login) overwrites an
    // unmarked password, and a proven account usually has a phone. A mark without the new
    // password is harmless (phone logins just use the magic link). accept_ also sets it.
    // No row back means no mark either (the users row is missing): the password stays as it was.
    const { data: marked, error: markErr } = await admin
      .from('users')
      .update({ password_set_at: new Date().toISOString() })
      .eq('id', checked.user_id)
      .select('id');
    if (markErr || !Array.isArray(marked) || marked.length === 0) {
      console.error('[team-invitation-code] password mark failed:', markErr?.message ?? 'no row');
      return json(req, { result: 'try_again' });
    }
    // email_confirm: since 2026-10-07 a GoTrue sign-up leaves the address unconfirmed, and an
    // unconfirmed address cannot sign in with a password.
    const { error: updateErr } = await admin.auth.admin.updateUserById(checked.user_id, { password, email_confirm: true });
    if (updateErr) return gotrueFailure(req, updateErr, 'update');
    userId = checked.user_id;
  } else {
    // Any other case, known or not, creates and touches no account (the check already refuses them).
    return json(req, { result: 'needs_google' });
  }

  const { data: acc, error: accErr } = await admin.rpc('accept_team_invitation_by_code', { p_token: token, p_user: userId });
  if (accErr) {
    console.error('[team-invitation-code] accept failed:', accErr.message);
    return json(req, { result: 'try_again' });
  }
  const accepted = (acc ?? {}) as { result?: string; role?: string };
  if (accepted.result !== 'accepted') return json(req, { result: accepted.result ?? 'try_again' });
  return json(req, { result: 'accepted', email, role: accepted.role });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await req.json();
    body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  } catch {
    return json(req, { error: 'bad_request' }, 400);
  }
  if (body.action !== 'send' && body.action !== 'verify') return json(req, { error: 'bad_request' }, 400);
  const token = typeof body.token === 'string' ? body.token : '';
  if (!TOKEN_RE.test(token)) return json(req, { result: 'not_found' });

  try {
    // Inside the try: createClient throws without a URL, and that must still answer with CORS.
    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const key = getServiceKey();
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return body.action === 'send' ? await send(req, admin, url, key, token) : await verify(req, admin, token, body);
  } catch (err) {
    console.error('[team-invitation-code] failed:', err instanceof Error ? err.message : String(err));
    return json(req, { error: 'internal' }, 500);
  }
});
