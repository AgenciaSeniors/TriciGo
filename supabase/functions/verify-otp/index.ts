import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS: restrict to allowed origins ──
// BUG-090: No hardcoded fallback — if ALLOWED_ORIGINS is empty, reject all cross-origin requests
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  // BUG-083: Reject oversized payloads (1 MB limit)
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    // Rate limit: 10 requests per IP per minute
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`verify-otp:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, getCorsHeaders(req));

    const { phone, code } = await req.json();

    if (!phone || !code) {
      return new Response(
        JSON.stringify({ error: 'Phone and code are required' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // BUG-186: per-phone rate limit (in addition to per-IP). Caps OTP
    // brute force at 10 verify attempts per phone per 10 minutes,
    // independent of how many IPs the attacker rotates through.
    const rlPhone = await rateLimit(`verify-otp:phone:${normalizedPhone}`, 10, 10 * 60 * 1000);
    if (!rlPhone.allowed) return rateLimitResponse(rlPhone.retryAfterMs, getCorsHeaders(req));

    // Supabase client (needed for both Cuba and user creation)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Verify against otp_codes via verify_cuba_otp RPC (all phones, D7-only) ──
    // Twilio Verify removed 2026-06-07. Every phone (Cuba + rest of world) now
    // uses the same atomic RPC (lock row + check + increment in one txn) — the
    // RPC is phone-agnostic; the "cuba" name is historical. BUG-184: atomicity
    // prevents the OTP brute-force race + off-by-one.
    const { data: rpcResult, error: rpcError } = await supabase.rpc('verify_cuba_otp', {
      p_phone: normalizedPhone,
      p_code: code,
    });

    if (rpcError) {
      console.error('verify_cuba_otp RPC failed:', rpcError);
      return new Response(
        JSON.stringify({ error: 'Verification service unavailable' }),
        { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    const result = rpcResult as { ok: boolean; error?: string; attempts_remaining?: number };
    if (!result?.ok) {
      // Idempotency: if the SAME code was verified very recently (≤3 min), the
      // user already proved possession. A transient session-mint failure on the
      // first attempt burns the code, so a plain retry would 400 and strand them.
      // Allow re-minting the session within that short window (the attacker would
      // still need the real code, so this opens no enumeration/brute-force hole).
      let recentlyVerified = false;
      if (result?.error === 'no_active_code') {
        const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        const { data: recent } = await supabase
          .from('otp_codes')
          .select('id')
          .eq('phone', normalizedPhone)
          .eq('code', code)
          .gte('verified_at', cutoff)
          .limit(1);
        recentlyVerified = !!(recent && recent.length > 0);
      }
      if (!recentlyVerified) {
        const errCode = result?.error;
        const userMsg =
          errCode === 'too_many_attempts' ? 'Too many attempts. Request a new code.'
          : 'Invalid or expired code';
        return new Response(
          JSON.stringify({ error: userMsg, attempts_remaining: result?.attempts_remaining }),
          { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }
      console.log('OTP recently verified — idempotent session re-mint');
    }

    // Do not log the phone number (PII). The user id is logged later if needed.
    console.log('OTP verified');

    // ── Code verified — create or find user (shared for both paths) ──

    // Find or create user in auth.users
    const devEmail = `phone_${normalizedPhone.replace(/\+/g, '')}@tricigo.app`;

    // Try to find existing user by email
    // AUD2-002: indexed lookup via RPC instead of an UNPAGINATED listUsers() (which only saw the
    // first ~50 users of auth.users — past one page, an existing user was not found, fell through to
    // createUser, hit a phone-collision 500 and could never log in). The RPC is service_role-only.
    let existingUserId: string | undefined;
    try {
      const { data: foundId, error: lookupError } = await supabase.rpc('lookup_auth_user_by_contact', {
        p_email: devEmail,
        p_phone: normalizedPhone,
      });
      if (lookupError) throw lookupError;
      existingUserId = (foundId as string | null) ?? undefined;
    } catch (err) {
      console.error('Failed to look up user:', err);
      return new Response(
        JSON.stringify({ error: 'Authentication service unavailable' }),
        { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    let userId: string;

    if (existingUserId) {
      userId = existingUserId;
      // Ensure the phone is set + confirmed (idempotent; never fatal to login).
      await supabase.auth.admin
        .updateUserById(userId, { phone: normalizedPhone, phone_confirm: true })
        .catch((e) => console.warn('updateUserById phone failed (non-fatal):', e));
    } else {
      // Create new user
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: devEmail,
        phone: normalizedPhone,
        phone_confirm: true,
        email_confirm: true,
        password: `otp_${Date.now()}_${crypto.randomUUID()}`,
        user_metadata: { phone: normalizedPhone },
      });

      if (createError || !newUser.user) {
        console.error('Failed to create user:', createError);
        return new Response(
          JSON.stringify({ error: 'Failed to create account' }),
          { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      userId = newUser.user.id;

      // Fix NULL token columns (prevent "Database error querying schema").
      // ROOT CAUSE of the new-user signup 500: `supabase.rpc(...)` returns a
      // PostgrestFilterBuilder (a thenable) that has NO `.catch` method — chaining
      // `.catch` throws "TypeError: supabase.rpc(...).catch is not a function",
      // which (only on the createUser path) bubbled to the catch-all → HTTP 500.
      // A recent @supabase/supabase-js@2 bump from esm.sh (unpinned) surfaced it.
      // Await the builder and inspect `error` instead of chaining `.catch`.
      try {
        const { error: fixErr } = await supabase.rpc('fix_null_auth_tokens', { p_user_id: userId });
        if (fixErr) {
          console.warn('fix_null_auth_tokens failed, trying admin fallback:', fixErr.message);
          const { error: fbErr } = await supabase.auth.admin.updateUserById(userId, {
            user_metadata: { tokens_fixed: true },
          });
          if (fbErr) console.warn('Could not fix NULL tokens, may cause issues:', fbErr.message);
        }
      } catch (e) {
        console.warn('fix_null_auth_tokens threw (non-fatal):', e instanceof Error ? e.message : String(e));
      }
    }

    // ── Code verified, user ensured — mint a session (robust, multi-strategy) ──
    // The old magic-link dance was fragile under PKCE / asymmetric (ES256) signing
    // keys: the action_link uses `token_hash` (not `token`), and `new URL(...)` /
    // verifyOtp could THROW, bubbling to the catch-all → HTTP 500 that stranded
    // EVERY new user (the OTP is already burned, so the retry then 400s). Try the
    // reliable password grant first, then the magic-link hashed_token; each
    // strategy is isolated so a single failure can't 500 the whole request.
    // Return 500 only if BOTH strategies fail.
    let session:
      | { access_token: string; refresh_token: string; expires_in: number; user: unknown }
      | null = null;

    // Strategy A — ephemeral password + signInWithPassword (NEVER log/return the password)
    try {
      const tempPassword = `otp_${crypto.randomUUID()}`;
      const { error: pwSetErr } = await supabase.auth.admin.updateUserById(userId, { password: tempPassword });
      if (pwSetErr) {
        console.error('updateUserById(password) failed:', pwSetErr.message);
      } else {
        const { data: pwData, error: pwErr } = await supabase.auth.signInWithPassword({
          email: devEmail,
          password: tempPassword,
        });
        if (pwErr) {
          console.error('signInWithPassword failed:', pwErr.message);
        } else if (pwData?.session) {
          session = {
            access_token: pwData.session.access_token,
            refresh_token: pwData.session.refresh_token,
            expires_in: pwData.session.expires_in,
            user: pwData.session.user,
          };
        }
      }
    } catch (e) {
      console.error('password-grant strategy threw:', e instanceof Error ? e.message : String(e));
    }

    // Strategy B — magic-link hashed_token (fallback; PKCE-correct)
    if (!session) {
      try {
        const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: devEmail,
        });
        const hashedToken = linkData?.properties?.hashed_token;
        if (linkError) {
          console.error('generateLink failed:', linkError.message);
        } else if (!hashedToken) {
          console.error('generateLink returned no hashed_token');
        } else {
          const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
            token_hash: hashedToken,
            type: 'magiclink',
          });
          if (verifyError) {
            console.error('verifyOtp(magiclink) failed:', verifyError.message);
          } else if (verifyData?.session) {
            session = {
              access_token: verifyData.session.access_token,
              refresh_token: verifyData.session.refresh_token,
              expires_in: verifyData.session.expires_in,
              user: verifyData.session.user,
            };
          }
        }
      } catch (e) {
        console.error('magic-link strategy threw:', e instanceof Error ? e.message : String(e));
      }
    }

    if (!session) {
      return new Response(
        JSON.stringify({ error: 'Failed to create session' }),
        { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    console.log('Session minted for user', userId);
    return new Response(
      JSON.stringify({ success: true, session }),
      { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('verify-otp error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  }
});
