// supabase/functions/send-sms/index.ts
// Sends transactional SMS via Twilio REST API.
// Called from the notify_ride_status_sms() database trigger via pg_net.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CORS: restrict to allowed origins ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface SmsRequest {
  user_id: string;
  phone: string;
  body: string;
  ride_id?: string;
  event_type?: string;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // ── Auth: allow internal service-role calls (pg_net triggers) or valid JWT ──
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const apiKey = req.headers.get('apikey') ?? '';
    const isInternalCall = apiKey === serviceRoleKey;

    if (!isInternalCall) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'Missing authorization header' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const supabaseAuth = createClient(
        Deno.env.get('SUPABASE_URL')!,
        serviceRoleKey,
      );
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
        authHeader.replace('Bearer ', ''),
      );

      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const { user_id, phone, body, ride_id, event_type } =
      (await req.json()) as SmsRequest;

    if (!phone || !body) {
      return new Response(
        JSON.stringify({ error: 'phone and body are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Read Twilio credentials from environment (same as Supabase Auth OTP)
    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const messagingServiceSid = Deno.env.get('TWILIO_MESSAGE_SERVICE_SID');

    if (!accountSid || !authToken || !messagingServiceSid) {
      console.error('[send-sms] Missing Twilio credentials in environment');
      return new Response(
        JSON.stringify({ error: 'SMS service not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Send SMS via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const basicAuth = btoa(`${accountSid}:${authToken}`);

    const formBody = new URLSearchParams({
      To: phone,
      MessagingServiceSid: messagingServiceSid,
      Body: body,
    });

    const twilioResponse = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString(),
    });

    const twilioResult = await twilioResponse.json();
    const success = twilioResponse.ok;
    const twilioSid = twilioResult.sid ?? null;

    // Log the SMS to sms_log table
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    await supabase.from('sms_log').insert({
      user_id: user_id || null,
      phone,
      message_body: body,
      ride_id: ride_id || null,
      event_type: event_type || 'unknown',
      twilio_sid: twilioSid,
      status: success ? 'sent' : 'failed',
    });

    if (!success) {
      console.error('[send-sms] Twilio error:', JSON.stringify(twilioResult));
      return new Response(
        JSON.stringify({ success: false, error: twilioResult.message ?? 'Twilio error' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, sid: twilioSid }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[send-sms] Error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
