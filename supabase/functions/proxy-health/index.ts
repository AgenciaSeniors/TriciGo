// ============================================================
// TriciGo — proxy-health Edge Function (Track 1 observability).
//
// Single sink for the NETOPIA payment-proxy health signal + a synthetic probe
// that runs INDEPENDENTLY of the VPS box (so a full-VPS outage still alerts).
//
//   • POST { source, status, squid_http?, npproxy_http? }
//       header: x-proxy-alert-secret == PROXY_HEALTH_SECRET
//     ← the VPS-local watchdog (ops/squid/healthcheck.sh) reports here.
//
//   • POST/GET ?probe=1   (same secret, OR service-role apikey — pg_cron)
//     ← the EF itself fetches https://tricigo.com/np-proxy/ from the Supabase
//       edge and derives the status. Catches "the whole VPS is down" (the
//       local watchdog can't self-report then).
//
// On every call it records the state in platform_config
// (netopia_proxy_health / _at / _detail) and, ONLY on a status TRANSITION
// (ok→down or down→ok), emails the business notification address via Resend
// (de-duped so a sustained outage doesn't spam). 'info' digests (anomaly) are
// recorded but never emailed.
//
// verify_jwt=false (own secret/service-role auth). See ops/squid/README.md.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const NP_PROXY_URL = Deno.env.get('NETOPIA_NP_PROXY_URL') ?? 'https://tricigo.com/np-proxy/';

function cors(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-proxy-alert-secret',
  };
}
function json(req: Request, body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Read one platform_config value (JSON-string tolerant). */
function cfgVal(rows: Array<{ key: string; value: unknown }>, key: string): string | null {
  const raw = rows.find((r) => r.key === key)?.value;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw.startsWith('"') ? JSON.parse(raw) : raw;
  return String(raw);
}

async function sendAlertEmail(supabase: ReturnType<typeof createClient>, subject: string, bodyHtml: string) {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) { console.error('[proxy-health] RESEND_API_KEY missing'); return; }
  const { data } = await supabase.from('platform_config').select('key, value').eq('key', 'business_notification_email');
  const to = cfgVal((data ?? []) as Array<{ key: string; value: unknown }>, 'business_notification_email');
  if (!to || !to.includes('@')) { console.log('[proxy-health] no business email — skip alert'); return; }
  const recipients = to.split(',').map((s) => s.trim()).filter((s) => s.includes('@'));
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: 'TriciGo Ops <noreply@tricigo.com>',
      reply_to: 'soporte@tricigo.com',
      to: recipients,
      subject,
      html: bodyHtml,
    }),
  });
  if (!r.ok) console.error('[proxy-health] resend error', await r.text());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });

  const url = new URL(req.url);
  const isProbe = url.searchParams.get('probe') === '1';
  const alertSecret = Deno.env.get('PROXY_HEALTH_SECRET') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';

  // ── Auth: shared alert secret OR service-role apikey (pg_cron) ──
  const gotSecret = req.headers.get('x-proxy-alert-secret') ?? '';
  const gotApiKey = req.headers.get('apikey') ?? '';
  const authed = (alertSecret && gotSecret === alertSecret) || (serviceRoleKey && gotApiKey === serviceRoleKey);
  if (!authed) return json(req, { ok: false, error: 'unauthorized' }, 401);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ── Derive the incoming signal ──
  let source = 'unknown';
  let status = 'unknown'; // 'ok' | 'down' | 'info'
  let squidHttp = '';
  let npproxyHttp = '';
  let extra: Record<string, unknown> = {};

  if (isProbe) {
    // Synthetic probe: fetch the np-proxy reverse proxy from the edge.
    source = 'edge-probe';
    const npSecret = Deno.env.get('NETOPIA_PROXY_SECRET') ?? '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(NP_PROXY_URL, { headers: { 'x-proxy-secret': npSecret }, signal: ctrl.signal });
      clearTimeout(t);
      npproxyHttp = String(res.status);
      // Reachable and not blocked/5xx = alive. 403 = secret drift; 5xx/000 = down.
      status = [403, 500, 502, 503, 504].includes(res.status) ? 'down' : 'ok';
    } catch (_e) {
      npproxyHttp = '000';
      status = 'down';
    }
  } else {
    try {
      const body = await req.json();
      source = String(body.source ?? 'vps-watchdog');
      status = String(body.status ?? 'unknown');
      squidHttp = String(body.squid_http ?? '');
      npproxyHttp = String(body.npproxy_http ?? '');
      extra = body;
    } catch (_e) {
      return json(req, { ok: false, error: 'bad_body' }, 400);
    }
  }

  const nowIso = new Date().toISOString();
  // Stored into a jsonb column → pass an object, not a pre-stringified string.
  const detail = { source, squid_http: squidHttp, npproxy_http: npproxyHttp, at: nowIso, extra };

  // 'info' (anomaly digest) is recorded but never changes health/alerts.
  if (status === 'info') {
    await supabase.from('platform_config').upsert(
      { key: 'netopia_proxy_anomaly', value: detail },
      { onConflict: 'key' },
    );
    return json(req, { ok: true, recorded: 'anomaly' }, 200);
  }

  // ── Read prior health for transition detection ──
  const { data: prior } = await supabase
    .from('platform_config')
    .select('key, value')
    .in('key', ['netopia_proxy_health']);
  const prev = cfgVal((prior ?? []) as Array<{ key: string; value: unknown }>, 'netopia_proxy_health') ?? 'unknown';

  // ── Record current state ──
  await supabase.from('platform_config').upsert(
    [
      { key: 'netopia_proxy_health', value: status },
      { key: 'netopia_proxy_health_at', value: nowIso },
      { key: 'netopia_proxy_health_detail', value: detail },
    ],
    { onConflict: 'key' },
  );

  // ── Alert ONLY on transition (de-dup) ──
  const transitioned = prev !== status && (status === 'down' || (status === 'ok' && prev === 'down'));
  if (transitioned) {
    const down = status === 'down';
    const subject = down
      ? '🔴 [TriciGo] Proxy de pagos NETOPIA CAÍDO'
      : '🟢 [TriciGo] Proxy de pagos NETOPIA recuperado';
    const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
      <h2 style="color:${down ? '#dc2626' : '#059669'};border-bottom:2px solid ${down ? '#dc2626' : '#059669'};padding-bottom:8px">
        ${down ? 'Proxy de pagos CAÍDO' : 'Proxy de pagos recuperado'}</h2>
      <p>${down
        ? 'El túnel de pagos NETOPIA no está respondiendo. Las recargas con tarjeta desde Cuba fallarán (caen al navegador → 403). Revisá el VPS 187.77.214.236 (squid :13128 / nginx /np-proxy/).'
        : 'El túnel de pagos NETOPIA volvió a responder. Las recargas con tarjeta funcionan de nuevo.'}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Estado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${esc(prev)} → <b>${esc(status)}</b></td></tr>
        <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Origen</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${esc(source)}</td></tr>
        <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>squid HTTP</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${esc(squidHttp || '—')}</td></tr>
        <tr><td style="padding:6px;border-bottom:1px solid #eee"><b>np-proxy HTTP</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${esc(npproxyHttp || '—')}</td></tr>
        <tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">${esc(nowIso)}</td></tr>
      </table>
      <p style="color:#777;font-size:12px">Alerta automática del watchdog del proxy de pagos. No responder.</p>
    </body></html>`;
    try { await sendAlertEmail(supabase, subject, html); } catch (e) { console.error('[proxy-health] alert send failed', e); }
  }

  return json(req, { ok: true, status, prev, transitioned }, 200);
});
