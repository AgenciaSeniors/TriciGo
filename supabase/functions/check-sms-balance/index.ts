// ============================================================
// TriciGo — check-sms-balance Edge Function.
//
// Avisa cuando el saldo prepago de D7 está por acabarse, ANTES de que alguien
// quede sin poder iniciar sesión.
//
// CONTEXTO (incidente 2026-08-06 → 2026-08-07)
// El saldo de D7 se agotó a las 15:34 UTC del 06-ago y el SMS quedó muerto 31 h.
// D7 gatea TODO el login por teléfono (send-sms-otp), el vínculo de teléfono
// (link-phone), el link de viaje a contactos de confianza (send-sms), las campañas
// (send-bulk-sms) y el SOS de emergencia (broadcast-emergency). 11 personas quedaron
// fuera: 3 conductores aprobados y 8 registros nuevos que nunca pudieron completarse.
//
// RELACIÓN CON 00556 (son complementarios, no redundantes)
//   • 00556 (SQL) detecta el apagón YA ocurrido, ~6 h después, vía rate_limits.
//     Cubre cualquier causa: token revocado, ruta bloqueada, red, caída de D7.
//   • Esta función PREVIENE el modo de falla más común — quedarse sin saldo —
//     avisando con ~11 días de anticipación al ritmo de consumo actual.
// Ninguna reemplaza a la otra: una mira la causa, la otra el efecto.
//
// POR QUÉ UNA EF Y NO SQL (a diferencia de 00503/00556)
// El D7_API_TOKEN vive como secret de Edge Function, no en la base, así que la
// consulta del saldo tiene que correr acá. El caso "esta función se murió y nadie
// se entera" YA está cubierto: el cron la invoca vía public.cron_http_post, y
// check_cron_http_failures() (00506/00507) alerta si deja de devolver 2xx.
//
// Endpoint (docs oficiales de D7, verificado 2026-08-07):
//   GET https://api.d7networks.com/messages/v1/balance
//   Accept: application/json · Authorization: Bearer <token>
//   200 → { "balance": 99.9999999 }
//   401 → { "detail": { "code": "ACCESS_TOKEN_...", "message": "..." } }
//
// verify_jwt = true: la invoca pg_cron con el service-role Bearer, igual que
// sync-weather y sync-exchange-rate.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const D7_BALANCE_URL = 'https://api.d7networks.com/messages/v1/balance';
const DEFAULT_ALERT_USD = 20;

/** Lee un valor de platform_config tolerando el jsonb string-entrecomillado. */
function cfgVal(rows: Array<{ key: string; value: unknown }>, key: string): string | null {
  const raw = rows.find((r) => r.key === key)?.value;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.startsWith('"') ? JSON.parse(raw) : raw;
  return String(raw);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { data: cfgData } = await supabase
    .from('platform_config')
    .select('key, value')
    .in('key', [
      'sms_balance_alert_usd',
      'sms_balance_usd',
      'sms_balance_at',
      'sms_balance_status',
      'business_notification_email',
    ]);
  const rows = (cfgData ?? []) as Array<{ key: string; value: unknown }>;

  const rawThreshold = Number.parseFloat(cfgVal(rows, 'sms_balance_alert_usd') ?? '');
  const thresholdUsd = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : DEFAULT_ALERT_USD;

  const prevStatus = cfgVal(rows, 'sms_balance_status') ?? 'unknown';
  const prevBalance = Number.parseFloat(cfgVal(rows, 'sms_balance_usd') ?? '');
  const prevAtMs = Date.parse(cfgVal(rows, 'sms_balance_at') ?? '');

  // ── Consultar el saldo a D7 ───────────────────────────────────────────────
  const token = Deno.env.get('D7_API_TOKEN');
  if (!token) {
    console.error('[check-sms-balance] D7_API_TOKEN not configured');
    // Config rota: NO tocamos el estado previo (no podemos afirmar nada del saldo)
    // y devolvemos no-2xx para que el watchdog de crons lo haga visible.
    return json({ ok: false, error: 'd7_not_configured' }, 503);
  }

  let balance: number | null = null;
  let fetchError = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(D7_BALANCE_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const payload = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      // Un 401 acá es token revocado/rotado — la MISMA causa que dejaría el envío
      // muerto, así que conviene que salga por el canal de fallos del cron.
      fetchError = `http_${res.status}: ${JSON.stringify(payload).slice(0, 300)}`;
    } else {
      const raw = (payload as { balance?: unknown }).balance;
      const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      if (Number.isFinite(parsed)) balance = parsed;
      else fetchError = `unparseable_balance: ${JSON.stringify(payload).slice(0, 300)}`;
    }
  } catch (err) {
    fetchError = `network: ${(err as Error).message}`;
  }

  if (balance === null) {
    console.error('[check-sms-balance] balance fetch failed:', fetchError);
    await supabase.from('platform_config').upsert(
      [{ key: 'sms_balance_error', value: `${nowIso} · ${fetchError}` }],
      { onConflict: 'key' },
    );
    // Estado previo intacto a propósito: no saber el saldo no es "saldo bajo".
    return json({ ok: false, error: 'balance_unavailable', detail: fetchError }, 502);
  }

  // ── Autonomía estimada, derivada de dos lecturas reales de saldo ──────────
  // Se calcula del consumo OBSERVADO (no de un precio por SMS hardcodeado, que
  // varía por destino). Si el saldo subió, hubo recarga → no hay burn que medir.
  let burnPerDay: number | null = null;
  let daysLeft: number | null = null;
  if (Number.isFinite(prevBalance) && Number.isFinite(prevAtMs)) {
    const elapsedDays = (nowMs - prevAtMs) / 86_400_000;
    const spent = prevBalance - balance;
    if (elapsedDays >= 0.2 && spent > 0) {
      burnPerDay = spent / elapsedDays;
      if (burnPerDay > 0) daysLeft = Math.floor(balance / burnPerDay);
    }
  }

  const status = balance <= thresholdUsd ? 'low' : 'ok';

  await supabase.from('platform_config').upsert(
    [
      { key: 'sms_balance_usd', value: balance },
      { key: 'sms_balance_at', value: nowIso },
      { key: 'sms_balance_status', value: status },
      { key: 'sms_balance_error', value: '' },
    ],
    { onConflict: 'key' },
  );

  // ── Alertar SOLO en transición; 'unknown' → 'ok' no molesta a nadie ───────
  const shouldAlert = (status === 'low' && prevStatus !== 'low')
    || (status === 'ok' && prevStatus === 'low');

  let emailsSent = 0;
  if (shouldAlert) {
    const to = cfgVal(rows, 'business_notification_email') ?? '';
    const recipients = to.split(',').map((s) => s.trim()).filter((s) => s.includes('@'));

    if (!recipients.length) {
      console.log('[check-sms-balance] no business_notification_email — skip alert');
    } else {
      const runwayRow = daysLeft !== null
        ? `<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Autonomía estimada</b></td>`
          + `<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">~${daysLeft} días`
          + ` (${burnPerDay!.toFixed(2)} USD/día)</td></tr>`
        : '';

      const subject = status === 'low'
        ? '[TriciGo] Saldo de SMS bajo — recargá D7 antes de que nadie pueda entrar'
        : '[TriciGo] Saldo de SMS recuperado';

      const html = status === 'low'
        ? '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          + '<h2 style="color:#d97706;border-bottom:2px solid #d97706;padding-bottom:8px">Saldo de SMS bajo</h2>'
          + `<p>El saldo de D7 bajó de <b>$${esc(thresholdUsd)}</b>. Cuando llegue a cero, `
          + 'dejan de salir los códigos de verificación y <b>nadie podrá iniciar sesión</b> '
          + '(conductores ni pasajeros), además del <b>SOS de emergencia</b> y el link de viaje '
          + 'a contactos de confianza.</p>'
          + '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          + `<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Saldo actual</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">$${esc(balance.toFixed(2))}</td></tr>`
          + `<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Umbral de aviso</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">$${esc(thresholdUsd)}</td></tr>`
          + runwayRow
          + `<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">${esc(nowIso)}</td></tr>`
          + '</table>'
          + '<p><b>Qué hacer:</b> recargar en <code>app.d7networks.com</code>. A ~$0.07 por SMS a Cuba, '
          + 'cada $10 rinden ~140 códigos. Si D7 ofrece recarga automática, activarla evita '
          + 'que esto vuelva a depender de que alguien mire el correo.</p>'
          + '<p style="color:#777;font-size:12px">Watchdog automático de saldo SMS. Umbral editable en '
          + 'platform_config.sms_balance_alert_usd. No responder.</p>'
          + '</body></html>'
        : '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          + '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Saldo de SMS recuperado</h2>'
          + `<p>El saldo de D7 volvió a subir por encima del umbral. Saldo actual: <b>$${esc(balance.toFixed(2))}</b>.</p>`
          + '<p style="color:#777;font-size:12px">Watchdog automático de saldo SMS. No responder.</p>'
          + '</body></html>';

      for (const rcpt of recipients) {
        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
            },
            body: JSON.stringify({
              recipient_email: rcpt,
              subject,
              // HTML crudo: send-email lo acepta por el legacy path de
              // resolveTemplate(). El guardrail solo rechaza slugs pelados.
              template: html,
              data: {},
            }),
          });
          if (r.ok) emailsSent += 1;
          else console.error('[check-sms-balance] send-email failed', r.status, await r.text());
        } catch (err) {
          console.error('[check-sms-balance] send-email threw', (err as Error).message);
        }
      }
    }
  }

  console.log('[check-sms-balance]', JSON.stringify({
    balance, threshold: thresholdUsd, status, prev: prevStatus, days_left: daysLeft, emails_sent: emailsSent,
  }));

  return json({
    ok: true,
    balance,
    threshold_usd: thresholdUsd,
    status,
    prev: prevStatus,
    burn_per_day: burnPerDay,
    days_left: daysLeft,
    transitioned: status !== prevStatus,
    emails_sent: emailsSent,
  }, 200);
});
