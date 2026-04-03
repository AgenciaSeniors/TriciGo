import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS: restrict to allowed origins ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? 'https://tricigo.com');
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  try {
    // Rate limit: 5 requests per IP per 10 minutes
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = rateLimit(`send-sms-otp:${clientIP}`, 5, 10 * 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const { phone } = await req.json();

    if (!phone || typeof phone !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Phone number is required' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Normalize phone: ensure starts with +
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // ── Route by country: Cuba → Meta Cloud API, rest → Twilio Verify ──
    if (normalizedPhone.startsWith('+53')) {
      // ── Cuba → Meta Cloud API WhatsApp ──
      const metaToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
      const metaPhoneId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');

      if (!metaToken || !metaPhoneId) {
        console.log(`[DEV] Cuba OTP requested for ${normalizedPhone} (no Meta credentials)`);
        return new Response(
          JSON.stringify({ success: true, dev: true, message: 'OTP requested (dev mode - check logs)' }),
          { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      // Generate 6-digit OTP
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)))
        .map(b => b % 10).join('');

      // Store in otp_codes table (expires in 10 min)
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );

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

      // Send via Meta Cloud API WhatsApp
      const whatsappTo = normalizedPhone.replace('+', '');
      const metaUrl = `https://graph.facebook.com/v21.0/${metaPhoneId}/messages`;

      const metaResponse = await fetch(metaUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${metaToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: whatsappTo,
          type: 'template',
          template: {
            name: 'otp_code',
            language: { code: 'es' },
            components: [{
              type: 'body',
              parameters: [{ type: 'text', text: code }],
            }],
          },
        }),
      });

      const metaResult = await metaResponse.json();
      console.log('Meta WhatsApp response:', JSON.stringify({ status: metaResponse.status, messages: metaResult.messages, error: metaResult.error }));

      if (!metaResponse.ok) {
        console.error('Meta WhatsApp error:', metaResult);
        return new Response(
          JSON.stringify({ success: false, error: metaResult.error?.message || 'Failed to send WhatsApp message' }),
          { status: 502, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Verification sent via WhatsApp' }),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );

    } else {
      // ── Rest of world → Twilio Verify ──
      const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
      const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
      const verifySid = Deno.env.get('TWILIO_VERIFY_SERVICE_SID');

      if (!accountSid || !authToken || !verifySid) {
        console.log(`[DEV] OTP requested for ${normalizedPhone} (no Twilio credentials)`);
        return new Response(
          JSON.stringify({ success: true, dev: true, message: 'OTP requested (dev mode - check logs)' }),
          { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      const twilioUrl = `https://verify.twilio.com/v2/Services/${verifySid}/Verifications`;
      const body = new URLSearchParams({
        To: normalizedPhone,
        Channel: 'whatsapp',
      });

      const verifyResponse = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const verifyResult = await verifyResponse.json();
      console.log('Twilio Verify response:', JSON.stringify({ sid: verifyResult.sid, status: verifyResult.status, channel: verifyResult.channel }));

      if (!verifyResponse.ok) {
        console.error('Twilio Verify error:', verifyResult);
        return new Response(
          JSON.stringify({ success: false, error: verifyResult.message || 'Failed to send verification' }),
          { status: 502, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, message: 'Verification sent via WhatsApp' }),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }
  } catch (err) {
    console.error('send-sms-otp error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  }
});
