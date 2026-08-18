// ============================================================
// TriciGo — confirm-email
//
// Canjea el token de verificación de correo emitido por
// add-email-with-verification y estampa public.users.email_verified_at —
// el flag del que gatean send-login-email-link y request-password-reset.
//
// Es la pieza que faltaba desde siempre: el comment de la EF emisora prometía
// un "callback que marca email_verified_at" que nunca se construyó, así que el
// flag quedaba NULL para siempre (auditoría del PR #960, 2026-08-17).
//
// Deliberadamente NO mintea sesión: el click solo prueba posesión del buzón.
// Si el correo era un typo y lo recibe otra persona, lo peor que puede hacer
// con este endpoint es confirmar el flag — nunca entrar a la cuenta.
//
// verify_jwt = false: quien clickea el link del correo no tiene sesión. La
// auth ES el token (32 bytes aleatorios, sha256 en la tabla, un solo uso, 24h).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
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
    // El espacio de tokens (2^256) hace la fuerza bruta irrelevante; el límite
    // por IP es solo higiene contra el martilleo del endpoint.
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`confirm-email:${clientIP}`, 10, 10 * 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs, cors);

    const { token } = (await req.json()) as { token?: string };
    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      return json({ error: 'invalid_token' }, 400);
    }

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0')).join('');

    const supaAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: row } = await supaAdmin
      .from('email_verification_tokens')
      .select('id, user_id, email, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return json({ error: 'invalid_or_expired' }, 400);
    }

    // El token confirma el correo PARA EL QUE fue emitido. Si el usuario cambió
    // el correo de nuevo después de emitirse este token, el emisor ya borró la
    // fila (un token vivo por usuario) — este guard es cinturón y tirantes.
    const { data: dbUser } = await supaAdmin
      .from('users').select('email').eq('id', row.user_id).maybeSingle();
    if (!dbUser || (dbUser.email ?? '').toLowerCase() !== row.email.toLowerCase()) {
      return json({ error: 'invalid_or_expired' }, 400);
    }

    // Un solo uso: marcar gastado ANTES de estampar, con guard de carrera (dos
    // clicks simultáneos → uno solo pasa).
    const { data: claimed } = await supaAdmin
      .from('email_verification_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('used_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      return json({ error: 'invalid_or_expired' }, 400);
    }

    // La estampa que todo lo demás gatea.
    const { error: stampErr } = await supaAdmin
      .from('users')
      .update({ email_verified_at: new Date().toISOString() })
      .eq('id', row.user_id);
    if (stampErr) {
      console.error('[confirm-email] stamp failed:', stampErr.message);
      return json({ error: 'internal' }, 500);
    }

    // Best-effort: alinear el flag nativo de GoTrue para que la Estrategia A de
    // verify-otp (signInWithPassword) no tropiece si el proyecto exige correo
    // confirmado. Nunca fatal: nuestro gate es email_verified_at, no este.
    await supaAdmin.auth.admin
      .updateUserById(row.user_id, { email_confirm: true })
      .catch((e) => console.warn('[confirm-email] email_confirm sync failed (non-fatal):', e?.message));

    await supaAdmin.from('security_audit_log').insert({
      action: 'email_verified',
      actor_id: row.user_id,
      target_id: row.user_id,
      details: { email: row.email },
    }).then(() => {}, () => {});

    console.log(`[confirm-email] verified for user ${row.user_id}`);
    return json({ success: true, email: row.email }, 200);
  } catch (err) {
    console.error('[confirm-email] error:', err);
    return json({ error: 'internal' }, 500);
  }
});
