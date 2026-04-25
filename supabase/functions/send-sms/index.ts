// supabase/functions/send-sms/index.ts
// BUG-147 + BUG-201: service_role-only via JWT role claim.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isServiceRoleJwt(authHeader: string): boolean {
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload?.role === 'service_role';
  } catch { return false; }
}

interface SmsRequest {
  user_id?: string;
  phone: string;
  body: string;
  ride_id?: string;
  event_type?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (!isServiceRoleJwt(req.headers.get('Authorization') ?? '')) {
    return new Response(
      JSON.stringify({ error: 'Forbidden: send-sms is internal-only' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { user_id, phone, body, ride_id, event_type } = (await req.json()) as SmsRequest;
    if (!phone || !body) {
      return new Response(JSON.stringify({ error: 'phone and body are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const messagingServiceSid = Deno.env.get('TWILIO_MESSAGE_SERVICE_SID');
    if (!accountSid || !authToken || !messagingServiceSid) {
      return new Response(JSON.stringify({ error: 'SMS service not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const basicAuth = btoa(`${accountSid}:${authToken}`);
    const formBody = new URLSearchParams({ To: phone, MessagingServiceSid: messagingServiceSid, Body: body });

    const twilioResponse = await fetch(twilioUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });

    const twilioResult = await twilioResponse.json();
    const success = twilioResponse.ok;
    const twilioSid = twilioResult.sid ?? null;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
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
      return new Response(JSON.stringify({ success: false, error: twilioResult.message ?? 'Twilio error' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, sid: twilioSid }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
