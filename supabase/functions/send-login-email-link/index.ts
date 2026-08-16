// ============================================================
// TriciGo — send-login-email-link
//
// Segunda puerta de entrada, para cuando el SMS no llega.
//
// CONTEXTO (incidente 2026-08-15). La ruta de D7 hacia ETECSA dejó de entregar
// durante 15 h 16 min: los códigos salían perfectos y no llegaba ninguno. Seis
// personas quedaron fuera, y los conductores no tenían NINGUNA alternativa —
// medido el 2026-08-16: 90 conductores y 260 pasajeros creados por teléfono
// tienen cero identidades sociales vinculadas. El botón de Google existe en la
// pantalla de login, pero entrar por ahí les crearía una cuenta NUEVA en vez de
// recuperar la suya, porque su identidad de auth cuelga del teléfono.
//
// Esta función manda un enlace de acceso al correo que el usuario ya promovió a
// identidad real desde su perfil (authService.addBackupEmail →
// add-email-with-verification). El enlace abre la app por deep link y deja la
// sesión puesta, sin pasar por SMS.
//
// POR QUÉ NO signInWithOtp() DEL CLIENTE
// Ese camino manda el correo por el servicio interno de Supabase, que en este
// proyecto NO tiene SMTP propio configurado y trae un tope de envíos muy bajo —
// inservible para 90 conductores. Acá se genera el enlace con
// admin.generateLink() y se manda por nuestra infraestructura (send-email →
// Resend), igual que request-password-reset y add-email-with-verification.
//
// POR QUÉ ENLACE Y NO CONTRASEÑA
// verify-otp mintea una contraseña determinística por usuario (PR #782) y la
// reescribe cuando no coincide. Cualquier contraseña propia quedaría pisada en
// silencio en el próximo login por SMS. El enlace no toca ese mecanismo.
//
// ANTI-ENUMERACIÓN: responde siempre { success: true }, exista o no la cuenta —
// mismo criterio que request-password-reset. Quien pruebe correos ajenos no
// aprende nada.
//
// verify_jwt = false: la llama gente que justamente NO puede iniciar sesión.
// El control es el rate limit + que el enlace viaje SOLO al correo registrado.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
const PUBLIC_BASE_URL = Deno.env.get('PUBLIC_TRACKING_BASE_URL') ?? 'https://tricigo.com';

// El destino NO se acepta crudo del cliente: un redirectTo libre convierte este
// endpoint en un ladrón de sesiones (el enlace lleva tokens en el fragmento).
// El cliente manda un identificador de app y acá se resuelve. Cada valor ya está
// en las Redirect URLs de Supabase Auth porque el login con Google los usa.
const REDIRECTS: Record<string, string> = {
  driver: 'tricigo-driver://auth/callback',
  client: 'tricigo://auth/callback',
  web: `${PUBLIC_BASE_URL}/auth/callback`,
};

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  try {
    const { email, app } = (await req.json()) as { email?: string; app?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'invalid_email' }, 400);
    }
    const redirectTo = REDIRECTS[app ?? ''] ?? null;
    if (!redirectTo) return json({ error: 'invalid_app' }, 400);

    const normalized = email.trim().toLowerCase();

    // Tope por correo: el enlace da acceso a la cuenta, así que un atacante no
    // debe poder inundar la casilla de la víctima ni sondear a ciegas.
    const rl = await rateLimit(`login-email-link:${normalized}`, 3, 3600_000);
    if (!rl.allowed) {
      return json({ error: 'rate_limited', retry_after_ms: rl.retryAfterMs }, 429);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supaAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Solo cuentas cuyo correo es una identidad REAL. Las creadas por teléfono
    // arrastran phone_<n>@tricigo.app: mandarles el enlace ahí no serviría (esa
    // casilla no existe) y delataría que la cuenta existe.
    const { data: dbUser } = await supaAdmin
      .from('users')
      .select('id, full_name, email')
      .eq('email', normalized)
      .maybeSingle();

    const isSynthetic = normalized.endsWith('@tricigo.app');

    if (dbUser && !isSynthetic) {
      const { data: linkData, error: linkErr } = await supaAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email: normalized,
        options: { redirectTo },
      });

      if (!linkErr && linkData?.properties?.action_link) {
        const nombre = esc(dbUser.full_name ?? '').split(' ')[0];
        const html =
          '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          + `<h2 style="color:#ff6a00;border-bottom:2px solid #ff6a00;padding-bottom:8px">Entrá a TriciGo</h2>`
          + `<p>${nombre ? `Hola ${nombre}. ` : ''}Tocá el botón para entrar a tu cuenta sin esperar el código por SMS.</p>`
          + '<p style="margin:24px 0">'
          + `<a href="${linkData.properties.action_link}" `
          + 'style="background:#ff6a00;color:#fff;padding:14px 28px;border-radius:8px;'
          + 'text-decoration:none;font-weight:600;display:inline-block">Entrar a mi cuenta</a>'
          + '</p>'
          + '<p style="color:#555;font-size:14px">El enlace vence en 1 hora y sirve una sola vez. '
          + 'Si no pediste entrar, ignorá este correo: tu cuenta sigue segura.</p>'
          + '<p style="color:#777;font-size:12px">TriciGo — movilidad urbana en Cuba. No responder.</p>'
          + '</body></html>';

        // Nuestro canal (Resend), no el interno de Supabase: es el que aguanta
        // volumen. HTML crudo por el legacy path de resolveTemplate() en
        // send-email, como ya hacen los watchdogs — evita tener que registrar un
        // template nuevo y redesplegar send-email (21 archivos) por un correo.
        await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({
            recipient_email: normalized,
            subject: 'Tu enlace para entrar a TriciGo',
            template: html,
            data: {},
          }),
        }).catch(() => {});
      } else {
        console.error('[send-login-email-link] generateLink failed:', linkErr?.message);
      }
    }

    // Respuesta idéntica exista o no la cuenta (anti-enumeración).
    return json({ success: true }, 200);
  } catch (err) {
    console.error('[send-login-email-link] error:', err);
    // Genérico también acá: un 500 distinguible sería otro oráculo.
    return json({ success: true }, 200);
  }
});
