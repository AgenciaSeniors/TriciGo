// ============================================================
// TriciGo — register-login-device
//
// Our own "new device login" detection, replacing GoTrue's native
// signed_in_new_device notification (disabled in config.toml). The
// mobile apps call this right after a successful OTP login, passing a
// STABLE per-install device_id (UUID persisted in expo-secure-store).
//
//   - device_id already known for this user  → refresh last_seen_at,
//     no email.
//   - device_id new AND user already had >=1 known device            → record it
//     and email a "new device" alert (if the user has an email on file).
//   - device_id new AND it's the user's FIRST recorded device        → record it
//     SILENTLY (no email). This prevents a blast of alerts to existing
//     users on their first post-deploy login.
//
// verify_jwt = true at the gateway. We re-derive the user from the JWT
// (never trust a user_id in the body). All DB writes + the send-email
// call use the service role. Best-effort: any failure returns 200 so a
// flaky device-check never blocks the user's login.
//
// Self-contained on purpose (only the remote supabase-js import, no
// ../_shared/* deps) so it deploys as a single file.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface RegisterDeviceRequest {
  device_id: string;
  platform?: string | null;
  model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
}

function ok(body: Record<string, unknown>, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!authHeader.startsWith('Bearer ')) {
      return ok({ ok: false, reason: 'unauthorized' }, cors);
    }

    // Re-derive the user from the JWT — never trust a body-supplied id.
    const supaUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !user) {
      return ok({ ok: false, reason: 'invalid_token' }, cors);
    }

    const body = (await req.json().catch(() => ({}))) as RegisterDeviceRequest;
    const deviceId = (body.device_id ?? '').toString().trim();
    // Stable per-install UUID; bound the length so a malformed client
    // can't write huge rows. Empty → nothing to track, succeed quietly.
    if (!deviceId || deviceId.length > 128) {
      return ok({ ok: false, reason: 'missing_device_id' }, cors);
    }

    const platform = body.platform?.toString().slice(0, 32) ?? null;
    const model = body.model?.toString().slice(0, 128) ?? null;
    const osVersion = body.os_version?.toString().slice(0, 64) ?? null;
    const appVersion = body.app_version?.toString().slice(0, 32) ?? null;

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Already known? Refresh and bail without emailing.
    const { data: existing } = await admin
      .from('user_known_devices')
      .select('id')
      .eq('user_id', user.id)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (existing) {
      await admin
        .from('user_known_devices')
        .update({ last_seen_at: new Date().toISOString(), model, os_version: osVersion, app_version: appVersion })
        .eq('id', existing.id);
      return ok({ ok: true, is_new: false }, cors);
    }

    // New device. Did the user already have any known device? If so,
    // this is a genuinely new device and we alert. If it's their first
    // ever, record silently (rollout/first-login safety).
    const { count: priorCount } = await admin
      .from('user_known_devices')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id);

    const hadPriorDevices = (priorCount ?? 0) > 0;

    const { error: insertErr } = await admin.from('user_known_devices').insert({
      user_id: user.id,
      device_id: deviceId,
      platform,
      model,
      os_version: osVersion,
      app_version: appVersion,
    });
    // A unique-violation here means a concurrent login already inserted
    // it — treat as known, don't email.
    if (insertErr) {
      return ok({ ok: true, is_new: false, note: 'insert_conflict_or_error' }, cors);
    }

    let emailed = false;
    if (hadPriorDevices) {
      // The auth email is a synthetic phone_<number>@tricigo.app; the
      // real address (if any) lives in public.users.email. No email on
      // file → record the device but skip the alert.
      const { data: dbUser } = await admin
        .from('users')
        .select('email')
        .eq('id', user.id)
        .maybeSingle();
      const recipient = dbUser?.email?.trim();

      if (recipient) {
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
        const date = new Date().toLocaleString('es-CU', {
          day: 'numeric', month: 'long', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
          timeZone: 'America/Havana',
        });
        const deviceLabel = [model, platform].filter(Boolean).join(' · ') || null;
        const osLabel = [osVersion, platform].filter(Boolean).join(' ') || platform || null;

        await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
            'apikey': serviceRoleKey,
          },
          body: JSON.stringify({
            template: 'new_device_login',
            recipient_email: recipient,
            data: { email: recipient, date, ip, device: deviceLabel, os: osLabel },
          }),
        }).then(() => { emailed = true; }, () => { /* best-effort */ });
      }
    }

    return ok({ ok: true, is_new: true, emailed }, cors);
  } catch (_err) {
    // Never block login on a device-check failure.
    return ok({ ok: false, reason: 'internal' }, cors);
  }
});
