// F2 (mensajería): notifica al destinatario por SMS cuando un ride
// cargo es aceptado. Idempotente — `claim_delivery_notification` solo
// devuelve filas si todavía no se notificó (UPDATE atómico).
//
// Caller: driver mobile app después de aceptar ride cargo. Auth: el
// JWT del driver — la RPC valida `auth.uid() IS NOT NULL` (cualquier
// usuario logueado puede invocar; la idempotency lock previene abuso).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface NotifyRequest { ride_id: string; }

const PUBLIC_BASE_URL = Deno.env.get('PUBLIC_TRACKING_BASE_URL') ?? 'https://tricigo.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { ride_id } = (await req.json()) as NotifyRequest;
    if (!ride_id) {
      return new Response(JSON.stringify({ error: 'ride_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cliente con el JWT del caller — la RPC valida auth.uid() y hace
    // UPDATE atómico que actúa como idempotency lock.
    const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claim, error: claimErr } = await supabaseUser.rpc('claim_delivery_notification', {
      p_ride_id: ride_id,
    });
    if (claimErr) {
      return new Response(JSON.stringify({ error: claimErr.message }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const row = (Array.isArray(claim) ? claim[0] : null) as
      | { share_token: string; recipient_phone: string; recipient_name: string;
          customer_first_name: string; estimated_duration_s: number; }
      | null;
    if (!row) {
      // Ya estaba notificado o el ride no califica — no es error.
      return new Response(JSON.stringify({ success: true, skipped: 'already_notified_or_not_eligible' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!row.recipient_phone || !row.share_token) {
      return new Response(JSON.stringify({ success: false, skipped: 'missing_phone_or_token' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Construir SMS. El destinatario llega a /delivery/{token}.
    const recipientFirst = (row.recipient_name ?? '').split(' ')[0] || 'Hola';
    const eta = row.estimated_duration_s ? `~${Math.ceil(row.estimated_duration_s / 60)} min` : '';
    const link = `${PUBLIC_BASE_URL}/delivery/${row.share_token}`;
    const customer = row.customer_first_name || 'un contacto';
    const body = eta
      ? `${recipientFirst}, ${customer} te envio un paquete via TriciGo. ETA ${eta}. Sigue tu envio: ${link}`
      : `${recipientFirst}, ${customer} te envio un paquete via TriciGo. Sigue tu envio: ${link}`;

    // Llama internamente a la Edge Function `send-sms` con service_role.
    const sendSmsResp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        phone: row.recipient_phone,
        body,
        ride_id,
        event_type: 'delivery_recipient_notify',
      }),
    });
    const sendSmsResult = await sendSmsResp.json();

    return new Response(JSON.stringify({
      success: sendSmsResp.ok && sendSmsResult.success !== false,
      sms: sendSmsResult,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
