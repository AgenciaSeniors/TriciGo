// send-sms — internal-only SMS sender. D7 Networks is the SOLE provider
// (Twilio removed 2026-06-07). Used by broadcast-emergency (SOS), the
// trusted-contact auto-share trigger (tracking link), and other
// server-side notifications. apikey === SUPABASE_SERVICE_ROLE_KEY.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { sendSmsViaD7 } from '../_shared/d7.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SmsRequest { user_id?: string; phone: string; body: string; ride_id?: string; event_type?: string; }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('apikey') ?? '';
  if (!serviceRoleKey || presented !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Forbidden: send-sms is internal-only' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const { user_id, phone, body, ride_id, event_type } = (await req.json()) as SmsRequest;
    if (!phone || !body) return new Response(JSON.stringify({ error: 'phone and body are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);

    // ── D7 Networks (sole SMS provider, Cuba + rest of world) ──
    const result = await sendSmsViaD7(phone, body, { tracker: supabase, eventType: event_type || 'unknown' });

    // Audit log. The legacy `twilio_sid` column now stores the D7 request_id.
    await supabase.from('sms_log').insert({
      user_id: user_id || null, phone, message_body: body,
      ride_id: ride_id || null, event_type: event_type || 'unknown',
      twilio_sid: result.requestId ?? null, status: result.ok ? 'sent' : 'failed',
    });

    if (!result.ok) {
      return new Response(JSON.stringify({ success: false, error: 'SMS provider failed' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, sid: result.requestId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
