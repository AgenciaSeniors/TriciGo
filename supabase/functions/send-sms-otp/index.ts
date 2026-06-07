import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { resolveDemoOtp } from '../_shared/demo-otp.ts';
import { sendSmsViaD7 } from '../_shared/d7.ts';

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
    // Rate limit: 5 requests per IP per 10 minutes
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-sms-otp:${clientIP}`, 5, 10 * 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, getCorsHeaders(req));

    const { phone } = await req.json();

    if (!phone || typeof phone !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Phone number is required' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Normalize phone: ensure starts with +
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // BUG-086: Validate E.164 phone format
    const e164Regex = /^\+[1-9]\d{6,14}$/;
    if (!e164Regex.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: 'Invalid phone format. Use E.164.' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // BUG-186: per-phone rate limit. Caps OTP-spam abuse where an
    // attacker rotates IPs to hammer the provider with OTP requests
    // for a victim's phone. 3 OTPs per phone per 5 minutes is generous.
    const rlPhone = await rateLimit(`send-sms-otp:phone:${normalizedPhone}`, 3, 5 * 60 * 1000);
    if (!rlPhone.allowed) return rateLimitResponse(rlPhone.retryAfterMs, getCorsHeaders(req));

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Google Play review demo account: seed a fixed code, skip real SMS ──
    // Env-gated: resolveDemoOtp returns null unless DEMO_PHONE + DEMO_OTP_CODE
    // are both set and the phone matches, so this path is inert in normal use.
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

    // ── All phones → D7 Networks SMS + otp_codes (sole provider) ──
    if (!Deno.env.get('D7_API_TOKEN')) {
      console.error('[send-sms-otp] D7_API_TOKEN not configured');
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
