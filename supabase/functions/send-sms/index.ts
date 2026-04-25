// supabase/functions/send-sms/index.ts
// Sends transactional SMS via Twilio REST API.
// Called from the notify_ride_status_sms() / notify_trusted_contacts_on_*
// database triggers via pg_net.
//
// BUG-147 fix: this EF accepts arbitrary phone + body strings and
// charges Twilio for every send. Any authenticated user could call it
// to spam victims and burn the platform's SMS budget. Now we accept
// ONLY service_role callers (the triggers themselves run with the
// service_role key in the apikey header). Any other caller — including
// admin app users with a regular JWT — is rejected with 401.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SmsRequest {
  user_id?: string;
  phone: string;
  body: string;
  ride_id?: string;
  event_type?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // BUG-147: only the service_role may invoke this. Triggers pass the
  // service_role key in the apikey header (see get_service_role_key()).
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('apikey') ?? '';
  if (!serviceRoleKey || presented !== serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: send-sms is internal-only' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { user_id, phone, body, ride_id, event_type } =
      (await req.json()) as SmsRequest;

    if (!phone || !body) {
      return new Response(
        JSON.stringify({ error: 'phone and body are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

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

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      serviceRoleKey,
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
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
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
