import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse, refundRateLimit } from '../_shared/rate-limiter.ts';
import { resolveDemoOtp } from '../_shared/demo-otp.ts';
import { sendSmsViaD7 } from '../_shared/d7.ts';

// ── OTP send rate limits ──────────────────────────────────────────────
// Two tumbling-window budgets gate every send. Tuned for Cuba (2026-07-10):
//
// Per-phone caps SMS-spam of ONE victim number. 6/10min = 36 SMS/hour, the
// SAME hourly ceiling as the old 3/5min but a more forgiving burst so a user
// retrying (client resend timer paces to ~1/min) isn't locked out mid-login.
//
// Per-IP is an aggregate cap. The old 5/10min was hostile to ETECSA's
// carrier-grade NAT, where many unrelated subscribers share one public IP —
// 5 requests from ANY of them in 10min locked out everyone else on that IP
// (verified: ETECSA IPs hit 2× the cap). Raised to 30/10min: CGNAT-friendly
// while still bounding a single-IP flood (per-phone still caps each victim).
//
// Failed sends are REFUNDED (see refundOtpBudget) so provider failures don't
// consume a user's budget — the tokens throttle delivered SMS, not failures.
const IP_MAX = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;
const PHONE_MAX = 6;
const PHONE_WINDOW_MS = 10 * 60 * 1000;

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

// Normalize a phone to E.164, applying Cuban ETECSA rules for local inputs.
// Mirrors @tricigo/utils normalizeCubanPhone / _normalize_cuban_phone (00487)
// — kept inline because Deno Edge Functions can't import @tricigo/utils.
function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[\s\-()]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  // Bare Cuban local mobile: 8 digits starting with 5 (legacy) or 6 (new 63/64)
  if (/^[56]\d{7}$/.test(digits)) return `+53${digits}`;
  // Cuban country code without +: 53 + 8-digit subscriber number
  if (/^53\d{8}$/.test(digits)) return `+${digits}`;
  // Otherwise treat as already-international E.164; just ensure a leading +
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

// D7 Networks is the SOLE OTP/SMS provider (Cuba + rest of world).
// Twilio Verify + Meta WhatsApp fallback were removed 2026-06-07.
// All phones now follow one flow: generate a 6-digit code, store it in
// otp_codes, and deliver via D7. verify-otp validates against otp_codes
// (verify_cuba_otp RPC) for every phone.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  try {
    // Per-IP rate limit (see IP_MAX above). CGNAT-tolerant.
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-sms-otp:${clientIP}`, IP_MAX, IP_WINDOW_MS);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, getCorsHeaders(req));

    const { phone } = await req.json();

    if (!phone || typeof phone !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Phone number is required' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Normalize to E.164. For Cuban destinations apply the canonical ETECSA
    // normalization (mirrors @tricigo/utils normalizeCubanPhone /
    // _normalize_cuban_phone — can't import @tricigo/utils into Deno) so a bare
    // 8-digit local number can't be mis-routed to the wrong country code
    // (e.g. "51234567" → "+51234567" = Peru instead of "+5351234567" = Cuba).
    const normalizedPhone = normalizePhone(phone);

    // BUG-086: Validate E.164 phone format
    const e164Regex = /^\+[1-9]\d{6,14}$/;
    if (!e164Regex.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: 'Invalid phone format. Use E.164.' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Cuba guard: any +53 destination must be a valid ETECSA mobile (5/6 + 7
    // digits). Blocks malformed +53 numbers and landlines from silently
    // consuming a code + burning provider cost on an undeliverable send.
    // International numbers (+55 Brazil, etc.) skip this and pass on E.164 alone.
    if (normalizedPhone.startsWith('+53') && !/^\+53[56]\d{7}$/.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: 'Invalid Cuban phone. Use +53 5XXXXXXX or +53 6XXXXXXX.' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Store-review demo account: seed a fixed code, skip real SMS ──
    // Env-gated: resolveDemoOtp returns null unless DEMO_PHONE + DEMO_OTP_CODE
    // are both set and the phone matches, so this path is inert in normal use.
    //
    // ORDER IS LOAD-BEARING: this sits ABOVE the per-phone rate limit on
    // purpose. Do not move it back down.
    //
    // The demo accounts used to be subject to PHONE_MAX sends per
    // PHONE_WINDOW_MS like any other number, so a reviewer — or Firebase Test
    // Lab, which retries automatically and in parallel — could trip it and get
    // locked out for ten minutes behind a generic "too many requests". A
    // blocked reviewer is a rejected submission. Production `rate_limits` shows
    // windows with 19, 16, 10 and 9 sends against the demo phone, all well past
    // PHONE_MAX, so this was not hypothetical.
    //
    // Exempting them costs nothing: this branch sends no SMS (no provider
    // spend, no D7 quota) and only rewrites a single row with a FIXED code, for
    // the two numbers in the DEMO_PHONE allowlist. The per-IP limit above still
    // applies, so the endpoint keeps a backstop against anyone hammering it.
    const demoCode = resolveDemoOtp(
      normalizedPhone,
      Deno.env.get('DEMO_PHONE'),
      Deno.env.get('DEMO_OTP_CODE'),
    );
    if (demoCode) {
      // Keep at most one live code for the demo phone — clear any prior
      // unverified row so the fixed code can't accumulate concurrent rows.
      await supabase.from('otp_codes')
        .delete()
        .eq('phone', normalizedPhone)
        .is('verified_at', null);
      const { error: demoInsertError } = await supabase.from('otp_codes').insert({
        phone: normalizedPhone,
        code: demoCode,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      if (demoInsertError) {
        console.error('Failed to store demo OTP:', demoInsertError.message, demoInsertError.code);
        return new Response(
          JSON.stringify({ error: 'Failed to generate verification code' }),
          { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }
      // Response is byte-identical to a normal D7 send so the bypass is
      // not observable to clients (no demo-account enumeration oracle).
      console.log('Demo OTP seeded for Play review account');
      return new Response(
        JSON.stringify({ success: true, message: 'Verification sent via SMS', provider: 'd7' }),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Refund both budgets when a send fails downstream (provider reject /
    // misconfig / DB error) so a user who never received a code isn't locked
    // out of retrying. Windows MUST match the rateLimit() calls above/below.
    const refundOtpBudget = async () => {
      await refundRateLimit(`send-sms-otp:phone:${normalizedPhone}`, PHONE_WINDOW_MS);
      await refundRateLimit(`send-sms-otp:${clientIP}`, IP_WINDOW_MS);
    };

    // BUG-186: per-phone rate limit. Caps OTP-spam of one victim number
    // (an attacker rotating IPs). See PHONE_MAX above.
    const rlPhone = await rateLimit(`send-sms-otp:phone:${normalizedPhone}`, PHONE_MAX, PHONE_WINDOW_MS);
    if (!rlPhone.allowed) return rateLimitResponse(rlPhone.retryAfterMs, getCorsHeaders(req));

    // ── All phones → D7 Networks SMS + otp_codes (sole provider) ──
    if (!Deno.env.get('D7_API_TOKEN')) {
      console.error('[send-sms-otp] D7_API_TOKEN not configured');
      await refundOtpBudget();
      return new Response(
        JSON.stringify({ error: 'SMS service not configured' }),
        { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Generate 6-digit OTP — verify-otp reads otp_codes via verify_cuba_otp RPC
    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map(b => b % 10).join('');

    // Store in otp_codes table (expires in 10 min)
    const { error: insertError } = await supabase.from('otp_codes').insert({
      phone: normalizedPhone,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    if (insertError) {
      console.error('Failed to store OTP:', insertError);
      await refundOtpBudget();
      return new Response(
        JSON.stringify({ error: 'Failed to generate verification code' }),
        { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    const result = await sendSmsViaD7(
      normalizedPhone,
      `Tu código TriciGo es ${code}. Vence en 10 min. No lo compartas.`,
      { tracker: supabase, eventType: 'otp' },
    );

    if (!result.ok) {
      console.error('[send-sms-otp] D7 send failed:', JSON.stringify(result.error));
      // No SMS went out → give the rate-limit tokens back so the user can retry.
      await refundOtpBudget();
      return new Response(
        JSON.stringify({ success: false, error: 'SMS provider failed' }),
        { status: 502, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Verification sent via SMS', provider: 'd7' }),
      { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('send-sms-otp error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  }
});
