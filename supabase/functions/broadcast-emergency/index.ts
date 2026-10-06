// broadcast-emergency
//
// Authenticated edge function que dispara una alerta SOS:
//   1. Verifica que el caller está autenticado (Supabase JWT en
//      Authorization: Bearer).
//   2. Lee `trusted_contacts` con `auto_share=true` del usuario.
//   3. Por cada contacto, llama internamente a `send-sms` (que es
//      service-role only) con un mensaje preformateado que incluye:
//        · Nombre del que pidió ayuda (de users, no del request)
//        · Maps URL con la ubicación reportada
//        · Conductor y placa, solo si el que pide ayuda es el pasajero del
//          viaje (de la base, no del request)
//        · Ride ID para referencia, solo si el que pide ayuda es parte del viaje
//   4. Devuelve un resumen `{ contacts_notified, sms_sids }`.
//
// La razón para esta función dedicada (en vez de llamar send-sms desde
// el cliente) es que send-sms requiere el service role key — el cliente
// nunca debería tenerlo. Esta función actúa de proxy con auth checks.
//
// Rate-limited por user_id: 1 broadcast cada 60s y 10 por día. Evita
// doble-tap o scripts vaciando el budget de SMS (D7 Networks).
//
// 2026-10-06: el texto del SMS ya no toma nada del request. Antes la app
// mandaba rider_name / driver_name / vehicle_plate y se pegaban tal cual, así
// que cualquier cuenta podía mandar SMS con texto propio, firmados "TriciGo",
// a los números que pusiera en sus contactos de confianza.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { getServiceKey } from '../_shared/service-key.ts';
import { buildSosSmsBody, cleanSmsField, validCoordinates } from '../_shared/sos-message.ts';

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
  /** IGNORED since 2026-10-06: the SMS takes names and plate from the database.
   *  Still accepted so installed apps that send them keep working. */
  driver_name?: string | null;
  vehicle_plate?: string | null;
  rider_name?: string | null;
  /** UI locale for the SMS body. Defaults to 'es' (Cuba). */
  locale?: 'es' | 'en' | 'pt';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = getServiceKey();
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

    // ─── Rate limit (per user, 1/min and 10/day) ───
    // The daily cap bounds what one account can spend on SMS: each SOS texts
    // up to 5 contacts. A real emergency is also covered by the incident
    // report trigger, which texts the same contacts from the database.
    const rl = await rateLimit(`broadcast-emergency:${user.id}`, 1, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);
    const rlDay = await rateLimit(`broadcast-emergency:day:${user.id}`, 10, 24 * 60 * 60 * 1000);
    if (!rlDay.allowed) return rateLimitResponse(rlDay.retryAfterMs);

    // ─── Validate body ───
    const body = (await req.json()) as BroadcastBody;
    if (!validCoordinates(body.latitude, body.longitude)) {
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

    // ─── Names and plate from the database, never from the request ───
    const { data: caller } = await admin
      .from('users').select('full_name').eq('id', user.id).maybeSingle();
    let driverName: string | null = null;
    let vehiclePlate: string | null = null;
    let rideRef: string | null = null;
    let rideId: string | undefined;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof body.ride_id === 'string' && UUID_RE.test(body.ride_id)) {
      const { data: ride } = await admin
        .from('rides').select('id, customer_id, driver_id').eq('id', body.ride_id).maybeSingle();
      let driverUserId: string | null = null;
      if (ride?.driver_id) {
        const { data: dp } = await admin
          .from('driver_profiles').select('user_id').eq('id', ride.driver_id).maybeSingle();
        driverUserId = dp?.user_id ?? null;
      }
      const isPassenger = !!ride && ride.customer_id === user.id;
      const isDriver = !!driverUserId && driverUserId === user.id;
      if (ride && (isPassenger || isDriver)) {
        rideId = ride.id;
        rideRef = ride.id.slice(0, 8);
        // The passenger's contacts need to know who is driving. The driver's
        // contacts get the driver's own name as the sender, as before.
        if (isPassenger && ride.driver_id && driverUserId) {
          const [{ data: du }, { data: veh }] = await Promise.all([
            admin.from('users').select('full_name').eq('id', driverUserId).maybeSingle(),
            admin.from('vehicles').select('plate_number').eq('driver_id', ride.driver_id)
              .eq('is_active', true).limit(1).maybeSingle(),
          ]);
          driverName = cleanSmsField(du?.full_name, 40);
          vehiclePlate = cleanSmsField(veh?.plate_number, 15);
        }
      }
    }

    // ─── Build SMS body once and broadcast in parallel ───
    const smsBody = buildSosSmsBody({
      latitude: body.latitude,
      longitude: body.longitude,
      riderName: cleanSmsField(caller?.full_name, 40),
      driverName,
      vehiclePlate,
      rideRef,
    }, locale);
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
            ride_id: rideId,
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
