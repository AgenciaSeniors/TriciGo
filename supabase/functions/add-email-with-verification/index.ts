// ============================================================
// TriciGo — add-email-with-verification
//
// El user logueado agrega/cambia su email. Workflow:
//   1. EF actualiza auth.users.email (email_confirm: false) y emite un TOKEN
//      PROPIO de un solo uso (24h) en email_verification_tokens.
//   2. EF manda email custom (template `email_verification`) con el link
//      https://tricigo.com/auth/email-confirmed?token=<t>.
//   3. La página canjea el token en la EF confirm-email, que estampa
//      public.users.email_verified_at — el gate de send-login-email-link y
//      request-password-reset.
//
// REDISEÑO 2026-08-17 (auditoría del PR #960). La versión anterior mandaba un
// MAGIC LINK de GoTrue como "link de verificación": un link que MINTEA SESIÓN.
// Con un typo en el correo, el dueño real de esa casilla recibía un enlace que
// le abría la cuenta del usuario con un click. El token propio solo prueba
// posesión del buzón — canjearlo no inicia sesión de nada. Además el paso
// "marcar email_verified_at" de la versión vieja apuntaba a un callback que
// nunca existió, así que el flag quedaba NULL para siempre y los resets de
// contraseña (que gatean en él) jamás salían para estos correos.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { qpSafeUrl } from '../_shared/qp-safe-url.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PUBLIC_BASE_URL = Deno.env.get('PUBLIC_TRACKING_BASE_URL') ?? 'https://tricigo.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supaUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // AUD2-007: rate-limit email add/change per authenticated user (anti email-bomb). The endpoint
    // triggers an outbound verification email per call; cap at 5 per user per hour.
    const rl = await rateLimit(`add-email:${user.id}`, 5, 60 * 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, corsHeaders);

    const { email: rawEmail } = (await req.json()) as { email: string };
    // Minúsculas SIEMPRE al guardar: send-login-email-link busca en minúsculas,
    // y un correo guardado como "Damian@Gmail.com" no matchearía nunca (el
    // conductor no recibiría el enlace, en silencio).
    const email = (rawEmail ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: 'invalid_email' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supaAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Check if email is already taken por otro user (ilike: filas legacy con
    // mayúsculas también cuentan como tomadas)
    const { data: existing } = await supaAdmin
      .from('users').select('id').ilike('email', email.replace(/[%_]/g, '\\$&')).maybeSingle();
    if (existing && existing.id !== user.id) {
      return new Response(JSON.stringify({ error: 'email_already_taken' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update email en auth.users (esto manda magic link por defecto si
    // está configurado, pero queremos custom template, así que generamos
    // el link manualmente con `email_change` type).
    const { error: updateErr } = await supaAdmin.auth.admin.updateUserById(user.id, {
      email,
      email_confirm: false,  // requerimos verificación
    });
    if (updateErr) {
      return new Response(JSON.stringify({ error: 'update_failed', detail: updateErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Token propio de un solo uso — NO es un magic link, canjearlo no mintea
    // sesión. Se guarda solo el sha256; el token viaja únicamente en el correo.
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

    // Un solo token vivo por usuario: pedir de nuevo invalida el anterior (y de
    // paso la tabla no acumula — no hace falta cron de limpieza).
    await supaAdmin.from('email_verification_tokens').delete().eq('user_id', user.id);
    const { error: tokenErr } = await supaAdmin.from('email_verification_tokens').insert({
      user_id: user.id,
      email,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    if (tokenErr) {
      return new Response(JSON.stringify({ error: 'link_generation_failed', detail: tokenErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // qpSafeUrl: sin la armadura, el `=` seguido del token hex se corrompe en
    // la entrega (QP-eater de Resend/SES, E2E 2026-08-18) y el enlace llega roto.
    const verificationLink = qpSafeUrl(`${PUBLIC_BASE_URL}/auth/email-confirmed?token=${token}`);

    // Get user full_name
    const { data: dbUser } = await supaAdmin
      .from('users').select('full_name').eq('id', user.id).maybeSingle();

    // Mandar email custom
    await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({
        template: 'email_verification',
        recipient_email: email,
        data: {
          full_name: dbUser?.full_name ?? '',
          email,
          verification_link: verificationLink,
        },
      }),
    }).catch(() => {});

    // Sync email a public.users (sin verified_at todavía)
    await supaAdmin.from('users').update({ email, email_verified_at: null }).eq('id', user.id);

    // Audit (security_audit_log, 00417 — the old audit_log target had no
    // action/actor_id/details columns so this insert silently failed).
    await supaAdmin.from('security_audit_log').insert({
      action: 'email_change_requested',
      actor_id: user.id,
      target_id: user.id,
      details: { new_email: email },
    }).then(() => {}, () => {});

    return new Response(JSON.stringify({ success: true, message: 'check_email_for_link' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'internal', detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
