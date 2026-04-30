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

  try {
    // Rate limit: 5 requests per IP per 10 minutes
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-sms-otp:${clientIP}`, 5, 10 * 60 * 1000);
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

    // BUG-086: Validate E.164 phone format
    const e164Regex = /^\+[1-9]\d{6,14}$/;
    if (!e164Regex.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: 'Invalid phone format. Use E.164.' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // BUG-186: per-phone rate limit. Caps OTP-spam abuse where an
    // attacker rotates IPs to hammer Twilio/Meta with OTP requests
    // for a victim's phone (annoyance + quota drain). 3 OTPs per
    // phone per 5 minutes is generous for legit retries.
    const rlPhone = await rateLimit(`send-sms-otp:phone:${normalizedPhone}`, 3, 5 * 60 * 1000);
    if (!rlPhone.allowed) return rateLimitResponse(rlPhone.retryAfterMs);

    // ── Route by country: Cuba → D7 SMS (with Meta WhatsApp fallback), rest → Twilio Verify ──
    if (normalizedPhone.startsWith('+53')) {
      // ── Cuba: D7 Networks SMS preferred, Meta WhatsApp fallback ──
      const d7Token = Deno.env.get('D7_API_TOKEN');
      const d7Sender = Deno.env.get('D7_SENDER_ID') || 'TriciGo';
      const metaToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN');
      const metaPhoneId = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');

      const useD7 = !!d7Token;
      const useMeta = !!(metaToken && metaPhoneId);

      if (!useD7 && !useMeta) {
        console.error(`[send-sms-otp] No Cuba OTP provider configured (need D7_API_TOKEN or META_WHATSAPP_*)`);
        return new Response(
          JSON.stringify({ error: 'SMS service not configured' }),
          { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      // Generate 6-digit OTP — verify-otp reads otp_codes via verify_cuba_otp RPC
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

      // ── D7 Networks SMS (preferred when configured) ──
      if (useD7) {
        const d7Url = 'https://api.d7networks.com/messages/v1/send';
        const d7Body = {
          messages: [{
            channel: 'sms',
            recipients: [normalizedPhone],
            content: `Tu código TriciGo es ${code}. Vence en 10 min. No lo compartas.`,
            msg_type: 'text',
            data_coding: 'text',
          }],
          message_globals: {
            originator: d7Sender,
            report_url: '',
          },
        };

        const d7Response = await fetch(d7Url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${d7Token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(d7Body),
        });

        const d7Result = await d7Response.json().catch(() => ({}));
        console.log('D7 Networks response:', JSON.stringify({
          status: d7Response.status,
          request_id: (d7Result as { request_id?: string }).request_id,
          errors: (d7Result as { errors?: unknown }).errors,
        }));

        if (d7Response.ok) {
          return new Response(
            JSON.stringify({ success: true, message: 'Verification sent via SMS', provider: 'd7' }),
            { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
          );
        }

        // D7 failed — fall through to Meta WhatsApp if configured
        console.error('D7 Networks failed, trying Meta fallback:', d7Result);
        if (!useMeta) {
          return new Response(
            JSON.stringify({ success: false, error: 'SMS provider failed', detail: d7Result }),
            { status: 502, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
          );
        }
      }

      // ── Meta WhatsApp fallback / primary if D7 not set ──
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
        JSON.stringify({ success: true, message: 'Verification sent via WhatsApp', provider: 'meta' }),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );

    } else {
      // ── Rest of world → Twilio Verify ──
      const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
      const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
      const verifySid = Deno.env.get('TWILIO_VERIFY_SERVICE_SID');

      if (!accountSid || !authToken || !verifySid) {
        // BUG-089: Return 503 error instead of fake success when SMS service is not configured
        console.error(`[send-sms-otp] Twilio Verify credentials not configured`);
        return new Response(
          JSON.stringify({ error: 'SMS service not configured' }),
          { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
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
