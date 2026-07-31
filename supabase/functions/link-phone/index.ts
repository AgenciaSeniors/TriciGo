// ============================================================
// link-phone
//
// Links a verified phone number to the CALLER's existing account (OAuth
// Google/Apple onboarding via /verify-phone + profile phone change).
//
// Exists because GoTrue's native phone_change flow
// (supabase.auth.updateUser({ phone }) + verifyOtp type='phone_change')
// sends its SMS through the [auth.sms] provider (Twilio), which does NOT
// deliver to Cuba (+53). Since PR #462 D7 Networks is the SOLE SMS
// provider: the code is sent by the send-sms-otp EF (D7, stored in
// otp_codes) and this function validates it against the SAME source
// verify-otp uses (verify_cuba_otp RPC), then links the phone server-side
// with the service-role admin API.
//
// Flow: client calls send-sms-otp (D7 SMS → otp_codes) → user types the
// code → client calls THIS function with { phone, code }.
//
// Auth: verify_jwt = false at the gateway (like storage-upload /
// delete-account) — we do our OWN Bearer-token auth inside via
// auth.getUser. The target user id ALWAYS comes from the caller's JWT,
// never from the request body, so a user can only link a phone to their
// own account.
//
// The Google Play review DEMO code needs no special-case here: send-sms-otp
// seeds the fixed demo code into otp_codes, so verify_cuba_otp validates it
// like any other code (same reason verify-otp has no demo branch).
//
// Request:  POST JSON { phone, code }
// Response: 200 { success: true }
//           400 { error: 'INVALID_CODE', attempts_remaining? } — bad/expired code
//           401 { error: 'UNAUTHORIZED' } — missing/invalid user token
//           409 { error: 'PHONE_TAKEN' } — phone belongs to another active user
//           4xx/5xx { error } — validation / infra
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
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

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// ── Telemetría del embudo de vinculación ──
// Sin esto el paso no deja rastro en ningún lado: los logs de Edge Function
// duran 24 h, otp_codes se purga a las pocas horas y sms_deliveries no guarda
// user_id. Al 2026-07-31 había 45 cuentas retenidas en /verify-phone y era
// imposible saber por qué (código vencido, número ya usado, o abandono):
// correlacionar por tiempo contra sms_deliveries no alcanza, porque en una
// ráfaga de altas el join empareja a cada usuario con el SMS de otro.
//
// Reusa log_rpc_attempt → rpc_attempt_log (mismo patrón que cancel_ride /
// accept_ride_v2), que ya trae EXCEPTION WHEN OTHERS THEN NULL adentro.
// Best-effort por partida doble: nunca puede tumbar la vinculación.
//
// PII: se guarda SOLO el prefijo (5 / 6 / otro), nunca el número — misma
// política que el resto de la función. El prefijo alcanza para separar un
// problema de cobertura de D7 (el rango 63/64 de ETECSA entrega peor) de un
// abandono real.
function phonePrefix(e164: string): string {
  if (e164.startsWith('+535')) return '5';
  if (e164.startsWith('+536')) return '6';
  return 'otro';
}

async function logAttempt(
  admin: ReturnType<typeof createClient>,
  userId: string | null,
  outcome: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await admin.rpc('log_rpc_attempt', {
      p_rpc_name: 'link-phone',
      p_caller_uid: userId,
      p_target_id: null,
      p_outcome: outcome,
      p_metadata: metadata,
    });
  } catch (err) {
    console.error('[link-phone] telemetry insert failed (non-fatal):', err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method_not_allowed' }, 405);
  }

  // BUG-083: Reject oversized payloads (1 MB limit)
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return jsonResponse(req, { error: 'Payload too large' }, 413);
  }

  try {
    // Rate limit: mirrors verify-otp (same OTP brute-force surface).
    // 10 requests per IP per minute.
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`link-phone:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, getCorsHeaders(req));

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      console.error('[link-phone] missing SUPABASE_* env');
      return jsonResponse(req, { error: 'misconfigured' }, 500);
    }

    // Se crea acá arriba (antes era después del rate limit) solo para que
    // logAttempt esté disponible en TODAS las salidas, incluidas las
    // tempranas. Es un objeto en memoria, no abre conexión: moverlo no
    // cambia el comportamiento.
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ─── 1. Auth: verify the Bearer token belongs to a real user ───
    // (Same pattern as storage-upload — anon client + caller's Authorization.)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse(req, { error: 'UNAUTHORIZED' }, 401);
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse(req, { error: 'UNAUTHORIZED' }, 401);
    }

    // ─── 2. Parse + normalize input ───
    const { phone, code } = await req.json();
    if (!phone || typeof phone !== 'string' || !code || typeof code !== 'string') {
      return jsonResponse(req, { error: 'Phone and code are required' }, 400);
    }
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    // BUG-086: Validate E.164 phone format (same as send-sms-otp, which is
    // where the code was stored under the normalized phone).
    const e164Regex = /^\+[1-9]\d{6,14}$/;
    if (!e164Regex.test(normalizedPhone)) {
      return jsonResponse(req, { error: 'Invalid phone format. Use E.164.' }, 400);
    }

    // BUG-186-style per-phone cap, independent of IP rotation:
    // 10 verify attempts per phone per 10 minutes (mirrors verify-otp).
    const rlPhone = await rateLimit(`link-phone:phone:${normalizedPhone}`, 10, 10 * 60 * 1000);
    if (!rlPhone.allowed) {
      await logAttempt(admin, user.id, 'rate_limited', { prefix: phonePrefix(normalizedPhone) });
      return rateLimitResponse(rlPhone.retryAfterMs, getCorsHeaders(req));
    }

    // ─── 3. Validate the code against otp_codes — SAME source as verify-otp ───
    // send-sms-otp (D7) wrote the code there; verify_cuba_otp is the atomic
    // phone-agnostic check (lock row + verify + increment in one txn, BUG-184
    // — the "cuba" name is historical).
    const { data: rpcResult, error: rpcError } = await admin.rpc('verify_cuba_otp', {
      p_phone: normalizedPhone,
      p_code: code,
    });
    if (rpcError) {
      console.error('[link-phone] verify_cuba_otp RPC failed:', rpcError);
      return jsonResponse(req, { error: 'Verification service unavailable' }, 503);
    }
    const result = rpcResult as { ok: boolean; error?: string; attempts_remaining?: number };
    if (!result?.ok) {
      console.log('[link-phone] code rejected:', result?.error ?? 'invalid');
      // `reason` distingue código vencido de código equivocado: si domina el
      // vencido, el problema es la demora de entrega del SMS, no el usuario.
      await logAttempt(admin, user.id, 'invalid_code', {
        prefix: phonePrefix(normalizedPhone),
        reason: result?.error ?? 'invalid',
      });
      return jsonResponse(
        req,
        { error: 'INVALID_CODE', attempts_remaining: result?.attempts_remaining },
        400,
      );
    }
    // Do not log the phone number (PII) — same policy as verify-otp.
    console.log('[link-phone] code verified for user', user.id);

    // ─── 4. Anti-collision: phone must not belong to another ACTIVE user ───
    // Checked AFTER code validation so an authenticated attacker can't use
    // this endpoint as a phone-enumeration oracle without actually owning
    // the phone (same concern as BUG-195 on find_user_by_phone).
    const { data: clash, error: clashError } = await admin
      .from('users')
      .select('id, created_at')
      .eq('phone', normalizedPhone)
      .neq('id', user.id)
      .eq('is_active', true)
      .limit(1);
    if (clashError) {
      console.error('[link-phone] collision check failed:', clashError);
      return jsonResponse(req, { error: 'Verification service unavailable' }, 503);
    }
    if (clash && clash.length > 0) {
      console.log('[link-phone] phone already owned by another active user');
      // `owner_predates_caller` prueba (o descarta) la hipótesis de la cuenta
      // duplicada: alguien que ya tenía cuenta por OTP entra después con
      // Google/Apple y al vincular SU PROPIO número se lo rechazamos. Si esto
      // domina, el arreglo no es de datos sino fusionar identidades.
      const ownerCreatedAt = (clash[0] as { created_at?: string }).created_at;
      await logAttempt(admin, user.id, 'phone_taken', {
        prefix: phonePrefix(normalizedPhone),
        layer: 'db',
        owner_predates_caller:
          ownerCreatedAt && user.created_at
            ? new Date(ownerCreatedAt) < new Date(user.created_at)
            : null,
      });
      return jsonResponse(req, { error: 'PHONE_TAKEN' }, 409);
    }

    // ─── 5. Link: auth.users (confirmed, no GoTrue SMS) + public.users mirror ───
    const { error: authUpdateError } = await admin.auth.admin.updateUserById(user.id, {
      phone: normalizedPhone,
      phone_confirm: true,
    });
    if (authUpdateError) {
      // GoTrue enforces phone uniqueness across auth.users — this covers
      // holders the is_active filter above skipped (e.g. deactivated rows).
      if (/already|exists|registered/i.test(authUpdateError.message ?? '')) {
        console.log('[link-phone] phone taken at auth layer');
        // layer 'auth' = lo cazó GoTrue y no el chequeo de arriba, o sea que
        // el dueño es una cuenta desactivada (que el filtro is_active saltea).
        await logAttempt(admin, user.id, 'phone_taken', {
          prefix: phonePrefix(normalizedPhone),
          layer: 'auth',
        });
        return jsonResponse(req, { error: 'PHONE_TAKEN' }, 409);
      }
      console.error('[link-phone] auth.admin.updateUserById failed:', authUpdateError);
      await logAttempt(admin, user.id, 'auth_update_failed', {
        prefix: phonePrefix(normalizedPhone),
      });
      return jsonResponse(req, { error: 'Failed to link phone' }, 500);
    }

    // Mirror into public.users. Best-effort: auth.users (source of truth for
    // login) is already linked at this point, and the verify-phone screens
    // also write the profile phone via updateProfile right after we return —
    // failing the whole request here would burn the (single-use) OTP code.
    const { error: dbError } = await admin
      .from('users')
      .update({ phone: normalizedPhone })
      .eq('id', user.id);
    if (dbError) {
      console.error('[link-phone] public.users phone mirror failed (non-fatal):', dbError);
    }

    console.log('[link-phone] phone linked for user', user.id);
    // El éxito también se registra: sin denominador, los fallos no se pueden
    // leer como tasa.
    await logAttempt(admin, user.id, 'success', {
      prefix: phonePrefix(normalizedPhone),
      mirror_ok: !dbError,
    });
    return jsonResponse(req, { success: true }, 200);
  } catch (err) {
    console.error('[link-phone] error:', err);
    return jsonResponse(req, { error: 'Internal server error' }, 500);
  }
});
