// ============================================================
// TriciGo — expo-proxy
//
// Reenvío transparente de UNA sola ruta de Expo: la que mintea el push token.
//
// ── Por qué existe ────────────────────────────────────────────────────────
// El registro de push tiene dos pasos y solo uno sale del país:
//
//   getDevicePushTokenAsync()                    celular → Google/Apple   OK
//   POST exp.host/--/api/v2/push/getExpoPushToken celular → Google Cloud  403
//   POST exp.host/--/api/v2/push/send            Supabase Edge → Expo     OK
//
// Ese 403 es la página de denegación del borde de Google Cloud delante de
// exp.host, vista desde una IP cubana. Medido el 2026-09-12 con la telemetría
// de 00585: de los conductores que concedieron el permiso, 10 de 14 fallaron
// ahí, y 9 de esos 10 NUNCA consiguieron un token — o sea que el bloqueo es
// persistente por dispositivo/red, no un blip. Supabase Edge, en cambio, llega
// a exp.host sin problema (send-push postea ahí todo el día).
//
// Esta función es ese salto: el celular le pide el token a Supabase, y Supabase
// se lo pide a Expo.
//
// ── verify_jwt = false, y NO es un descuido ──────────────────────────────
// El llamador es `getExpoPushTokenAsync` de expo-notifications, que hace su
// fetch con UN SOLO header: `content-type: application/json`. No hay hook para
// agregar otro. Es decir: no se puede exigir JWT ni secreto compartido. La
// defensa es la forma, no la credencial:
//
//   - solo POST, y solo a la subruta exacta `push/getExpoPushToken`
//   - el upstream está fijo en el código; esto NO es un relay genérico
//   - límite de tasa por IP
//
// El peor abuso posible es que alguien mintee tokens de Expo para device tokens
// propios, que es justo lo que el endpoint público de Expo ya le permite hacer.
//
// ── Regla dura: reenviar VERBATIM ────────────────────────────────────────
// El cliente exige exactamente {"data":{"expoPushToken":"ExponentPushToken[…]"}}.
// Cualquier otra forma le hace lanzar ERR_NOTIFICATIONS_SERVER_ERROR, que es
// retryable bajo la deny-list de packages/utils/src/pushRegistration.ts ⇒ un
// reenvío "mejorado" quemaría los 3 intentos y ~3,2 s de backoff en CADA
// arranque de la app. Por eso acá no se parsea ni se re-serializa nada: entra
// texto, sale texto.
// ============================================================

import { rateLimit } from '../_shared/rate-limiter.ts';

const UPSTREAM = 'https://exp.host/--/api/v2/push/getExpoPushToken';

// La subruta que arma Expo: `${baseUrl}push/getExpoPushToken`, con baseUrl
// apuntando a esta función. Ver getExpoPushTokenAsync.js:62-63.
const ALLOWED_SUFFIX = '/push/getExpoPushToken';

// Generoso a propósito: registrarse es un evento raro por persona, pero muchos
// dispositivos cubanos salen por la misma NAT de ETECSA, así que un límite
// estrecho por IP castigaría a gente legítima que comparte salida.
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const { pathname } = new URL(req.url);

  // Cualquier cosa que no sea exactamente el minteo de token no existe acá.
  // Esto es lo que impide que la función sirva como proxy de propósito general.
  if (req.method !== 'POST' || !pathname.endsWith(ALLOWED_SUFFIX)) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await rateLimit(`expo-proxy:${clientIP}`, RATE_MAX, RATE_WINDOW_MS);
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch (err) {
    // Expo inalcanzable DESDE SUPABASE. Distinto del 403 que motivó todo esto:
    // si esto aparece, el problema no es Cuba.
    console.error('[expo-proxy] upstream unreachable:', err);
    return new Response(JSON.stringify({ error: 'upstream_unreachable' }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const text = await upstream.text();

  if (!upstream.ok) {
    // El cuerpo ENTERO, sin recortar. Truncar el error del 403 a 300 caracteres
    // es exactamente lo que mantuvo este bug sin diagnosticar durante semanas.
    console.error(`[expo-proxy] Expo respondió ${upstream.status}: ${text}`);
  }

  // Verbatim: mismo status, mismo cuerpo. Ver la regla dura del encabezado.
  return new Response(text, {
    status: upstream.status,
    headers: {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    },
  });
});
