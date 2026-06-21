// broadcast-emergency
//
// Authenticated edge function que dispara una alerta SOS:
//   1. Verifica que el caller está autenticado (Supabase JWT en
//      Authorization: Bearer).
//   2. Lee `trusted_contacts` con `auto_share=true` del usuario.
//   3. Por cada contacto, llama internamente a `send-sms` (que es
//      service-role only) con un mensaje preformateado que incluye:
//        · Nombre del que pidió ayuda
//        · Maps URL con la ubicación reportada
//        · Datos del conductor (nombre/placa) si vienen en el ride
//        · Ride ID para referencia en soporte
//   4. Devuelve un resumen `{ contacts_notified, sms_sids }`.
//
// La razón para esta función dedicada (en vez de llamar send-sms desde
// el cliente) es que send-sms requiere el service role key — el cliente
// nunca debería tenerlo. Esta función actúa de proxy con auth checks.
//
// Rate-limited por user_id: 1 broadcast cada 60s. Evita doble-tap o
// scripts maliciosos vaciando el budget de SMS (D7 Networks).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface BroadcastBody {
  ride_id?: string;
  /** Reported location (rider's GPS). Both lat AND lng required. */
  latitude: number;
  longitude: number;
  /** Optional driver context for the SMS body. */
  driver_name?: string | null;
  vehicle_plate?: string | null;
  /** Optional rider display name (used in SMS to identify who called). */
  rider_name?: string | null;
  /** UI locale for the SMS body. Defaults to 'es' (Cuba). */
  locale?: 'es' | 'en' | 'pt';
}

function buildSmsBody(params: BroadcastBody, locale: 'es' | 'en' | 'pt'): string {
  const mapsUrl = `https://maps.google.com/?q=${params.latitude},${params.longitude}`;
  const riderName = params.rider_name?.trim() || 'Un usuario de TriciGo';
  const driverInfo = params.driver_name || params.vehicle_plate
    ? ` Conductor: ${[params.driver_name, params.vehicle_plate].filter(Boolean).join(' / ')}.`
    : '';
  const rideRef = params.ride_id ? ` Ride: ${params.ride_id.slice(0, 8)}.` : '';

  if (locale === 'en') {
    return `🚨 EMERGENCY: ${riderName} sent an SOS via TriciGo. Location: ${mapsUrl}${driverInfo}${rideRef}`;
  }
  if (locale === 'pt') {
    return `🚨 EMERGÊNCIA: ${riderName} enviou um SOS pelo TriciGo. Local: ${mapsUrl}${driverInfo}${rideRef}`;
  }
  return `🚨 EMERGENCIA: ${riderName} envió un SOS desde TriciGo. Ubicación: ${mapsUrl}${driverInfo}${rideRef}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Edge function misconfigured' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  }

  try {
    // ─── Auth check ───
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Authorization required' }),
        { status: 401, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
    }
    const userClient = createClient(supabaseUrl, serviceRoleKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }),
        { status: 401, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
    }

    // ─── Rate limit (per user, 1/min) ───
    const rl = await rateLimit(`broadcast-emergency:${user.id}`, 1, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // ─── Validate body ───
    const body = (await req.json()) as BroadcastBody;
    if (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude)) {
      return new Response(JSON.stringify({ error: 'latitude and longitude are required' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
    }
    const locale = (body.locale === 'en' || body.locale === 'pt') ? body.locale : 'es';

    // ─── Get trusted contacts (auto_share = true) ───
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: contacts, error: contactsErr } = await admin
      .from('trusted_contacts')
      .select('id, name, phone, auto_share')
      .eq('user_id', user.id)
      .eq('auto_share', true);
    if (contactsErr) {
      return new Response(JSON.stringify({ error: contactsErr.message }),
        { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
    }
    if (!contacts || contacts.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        contacts_notified: 0,
        message: 'No trusted contacts configured for auto-share',
      }), { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
    }

    // ─── Build SMS body once and broadcast in parallel ───
    const smsBody = buildSmsBody(body, locale);
    const sendSmsUrl = `${supabaseUrl}/functions/v1/send-sms`;

    const sids: Array<{ contact_id: string; sid: string | null; ok: boolean; error?: string }> = [];
    await Promise.all(contacts.map(async (c) => {
      try {
        const res = await fetch(sendSmsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({
            user_id: user.id,
            phone: c.phone,
            body: smsBody,
            ride_id: body.ride_id ?? undefined,
            event_type: 'emergency_broadcast',
          }),
        });
        const result = await res.json().catch(() => ({}));
        sids.push({
          contact_id: c.id,
          sid: result.sid ?? null,
          ok: !!result.success,
          error: result.error ?? undefined,
        });
      } catch (err) {
        sids.push({ contact_id: c.id, sid: null, ok: false, error: (err as Error).message });
      }
    }));

    const ok_count = sids.filter((s) => s.ok).length;

    return new Response(JSON.stringify({
      success: true,
      contacts_notified: ok_count,
      contacts_total: contacts.length,
      results: sids,
    }), { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  }
});
