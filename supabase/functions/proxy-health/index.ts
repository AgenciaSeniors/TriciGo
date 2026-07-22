// ============================================================
// TriciGo — proxy-health Edge Function (v2: per-layer state + debounced alerts).
//
// Single sink for the NETOPIA payment-proxy health signal + a synthetic probe
// that runs INDEPENDENTLY of the VPS box (so a full-VPS outage still alerts).
//
//   • POST { source, status, squid_http?, npproxy_http?, squid_state?, npproxy_state? }
//       header: x-proxy-alert-secret == PROXY_HEALTH_SECRET
//     ← the VPS-local watchdog (ops/squid/healthcheck.sh) reports here.
//
//   • POST/GET ?probe=1   (same secret, OR service-role apikey — pg_cron)
//     ← the EF itself fetches https://tricigo.com/np-proxy/ from the Supabase
//       edge and derives the status.
//
// Why v2 (2026-07-21): v1 kept ONE shared state key written by two reporters
// with different scopes (vps-watchdog: squid+npproxy; edge-probe: npproxy
// only), so a squid-only incident made them disagree and the state flapped
// ok<->down every ~2 min → 10 emails for one incident (2026-07-20 NETOPIA edge
// stall). Single-probe blips also emailed immediately (2026-07-21 NETOPIA 502s).
//
//   • Per-LAYER state in platform_config, each layer has a single writer:
//       netopia_proxy_health_squid    ← vps-watchdog (CONNECT tunnel :13128)
//       netopia_proxy_health_npproxy  ← vps-watchdog (nginx /np-proxy/)
//       netopia_proxy_health_edge     ← edge-probe   (np-proxy from the edge)
//     plus _since (episode start) and _alerted (down email sent) per layer.
//     netopia_proxy_health stays as the worst-of rollup (back-compat).
//   • Time debounce: a layer must be CONTINUOUSLY non-ok for
//     netopia_proxy_alert_after_s (default 600 s) before the one alert email;
//     the recovery email is sent only if that alert went out.
//   • Honest classification (watchdog v2 payload): 'down' = the VPS service
//     itself is broken (ssh/restart useful) vs 'upstream' = NETOPIA failing
//     both through AND around the proxy (direct-from-VPS control probe also
//     fails → do NOT touch the VPS) vs 'config' = broken configuration:
//     /np-proxy/ 403 (x-proxy-secret drift) OR the watchdog's own probe could
//     not run at all (NP_PROXY_SECRET unset / hmac_secret missing — HTTP "-").
//   • The edge layer alerts ONLY if the vps-watchdog has ALSO been silent
//     >15 min (⇒ the whole VPS is likely down). Edge-only failures while the
//     watchdog reports fine are recorded but never emailed (path noise
//     between the Supabase edge and the VPS).
//
// Old watchdog payloads (no *_state fields) are tolerated (derived like v1).
// 'info' digests (anomaly) are recorded but never emailed.
// verify_jwt=false (own secret/service-role auth). See ops/squid/README.md.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const NP_PROXY_URL = Deno.env.get('NETOPIA_NP_PROXY_URL') ?? 'https://tricigo.com/np-proxy/';

type LayerName = 'squid' | 'npproxy' | 'edge';
type LayerState = 'ok' | 'down' | 'upstream' | 'config';

const LAYERS: LayerName[] = ['squid', 'npproxy', 'edge'];
const SEVERITY: Record<LayerState, number> = { down: 3, config: 2, upstream: 1, ok: 0 };
/** edge 'down' only alerts when the vps-watchdog has been silent this long. */
const WATCHDOG_STALE_MS = 15 * 60 * 1000;
const DEFAULT_ALERT_AFTER_S = 600;

const LAYER_LABEL: Record<LayerName, string> = {
  squid: 'túnel squid :13128 (checkout in-app)',
  npproxy: 'nginx /np-proxy/ (server→NETOPIA)',
  edge: 'VPS visto desde internet',
};

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

function sanitizeState(s: unknown): LayerState | null {
  return s === 'ok' || s === 'down' || s === 'upstream' || s === 'config' ? (s as LayerState) : null;
}

/** What the alert should say for a non-ok layer state, including what to do. */
function explainState(layer: LayerName, state: LayerState): string {
  if (state === 'upstream') {
    return layer === 'squid'
      ? 'NETOPIA (secure.mobilpay.ro/ui/card) no responde NI en directo desde el VPS: el problema es del lado de NETOPIA/Google Cloud, no del VPS. No reinicies nada — se recupera solo cuando NETOPIA vuelva (patrón del incidente 2026-07-20).'
      : 'NETOPIA (/pay/) devuelve error también consultada en directo desde el VPS: problema del lado de NETOPIA. No toques el VPS.';
  }
  if (state === 'config') {
    if (layer === 'squid') {
      return 'El watchdog no pudo mintear el token efímero: /etc/squid/hmac_secret falta, está vacío o es ilegible. OJO: el helper de auth de squid lee el MISMO archivo, así que el checkout real probablemente también esté fallando (407). Fix: restaurar el secreto (openssl rand -hex 32 > /etc/squid/hmac_secret; chown proxy:proxy; chmod 600) y verificar que NETOPIA_PROXY_HMAC_SECRET de la EF mint tenga el mismo valor. Reiniciar squid NO lo arregla.';
    }
    return 'El guard x-proxy-secret no valida. Si el HTTP es 403 → drift de secreto entre el server block nginx (/etc/nginx/sites-available/tricigo.com) y NETOPIA_PROXY_SECRET (EF) / NP_PROXY_SECRET (/etc/tricigo/proxy-health.env). Si el HTTP es «-» → el watchdog no tiene NP_PROXY_SECRET configurado y la sonda ni corrió (nginx puede estar perfecto). Es configuración: ni reload ni restart lo arreglan.';
  }
  // state === 'down'
  if (layer === 'squid') {
    return 'El servicio squid del VPS está roto (NETOPIA sí responde en directo desde el VPS, pero el túnel no). El watchdog ya intenta reiniciarlo solo; si persiste: ssh root@187.77.214.236 → systemctl status squid / journalctl -u squid -n 50.';
  }
  if (layer === 'npproxy') {
    return 'nginx /np-proxy/ falla con NETOPIA sana en directo → problema de nginx en el VPS. El watchdog ya intenta un reload; si persiste: systemctl status nginx + /var/log/nginx/error.log.';
  }
  return 'La sonda externa no alcanza el VPS y su watchdog local lleva >15 min sin reportar → probablemente el VPS entero está caído o sin red. Acción: panel de Hostinger (srv1411116) / reiniciar el VPS.';
}

function subjectFor(layer: LayerName, state: LayerState): string {
  if (state === 'upstream') return `NETOPIA con problemas (${layer})`;
  if (state === 'config') {
    return layer === 'squid'
      ? 'secreto HMAC del túnel roto/ausente (squid)'
      : `secreto x-proxy-secret roto/ausente (${layer})`;
  }
  if (layer === 'edge') return 'VPS inaccesible desde internet';
  return `${layer} caído en el VPS`;
}

async function sendAlertEmail(recipients: string[], subject: string, bodyHtml: string) {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) { console.error('[proxy-health] RESEND_API_KEY missing'); return; }
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

  // ── Derive the incoming signal → per-layer observed states ──
  let source = 'unknown';
  let squidHttp = '';
  let npproxyHttp = '';
  let extra: Record<string, unknown> = {};
  const layerReports: Partial<Record<LayerName, LayerState>> = {};

  if (isProbe) {
    // Synthetic probe: fetch the np-proxy reverse proxy from the Supabase edge.
    source = 'edge-probe';
    const npSecret = Deno.env.get('NETOPIA_PROXY_SECRET') ?? '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(NP_PROXY_URL, { headers: { 'x-proxy-secret': npSecret }, signal: ctrl.signal });
      clearTimeout(t);
      npproxyHttp = String(res.status);
      layerReports.edge = res.status === 403
        ? 'config'
        : [500, 502, 503, 504].includes(res.status) ? 'down' : 'ok';
    } catch (_e) {
      npproxyHttp = '000';
      layerReports.edge = 'down';
    }
  } else {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (_e) {
      return json(req, { ok: false, error: 'bad_body' }, 400);
    }
    source = String(body.source ?? 'vps-watchdog');
    squidHttp = String(body.squid_http ?? '');
    npproxyHttp = String(body.npproxy_http ?? '');
    extra = body;

    // 'info' (anomaly digest) is recorded but never changes health/alerts.
    if (String(body.status ?? '') === 'info') {
      const nowIso = new Date().toISOString();
      await supabase.from('platform_config').upsert(
        { key: 'netopia_proxy_anomaly', value: { source, at: nowIso, extra } },
        { onConflict: 'key' },
      );
      return json(req, { ok: true, recorded: 'anomaly' }, 200);
    }

    // v2 payload carries classified states; legacy payloads are derived like v1.
    layerReports.squid = sanitizeState(body.squid_state)
      ?? (squidHttp === '200' ? 'ok' : 'down');
    layerReports.npproxy = sanitizeState(body.npproxy_state)
      ?? (npproxyHttp === '403'
        ? 'config'
        : ['000', '500', '502', '503', '504'].includes(npproxyHttp) ? 'down' : 'ok');
  }

  // ── Read prior per-layer state + tunables in one round-trip ──
  const cfgKeys = [
    'netopia_proxy_alert_after_s',
    'netopia_proxy_watchdog_last_at',
    'business_notification_email',
    ...LAYERS.flatMap((l) => [
      `netopia_proxy_health_${l}`,
      `netopia_proxy_health_${l}_since`,
      `netopia_proxy_health_${l}_alerted`,
    ]),
  ];
  const { data: cfgData } = await supabase.from('platform_config').select('key, value').in('key', cfgKeys);
  const rows = (cfgData ?? []) as Array<{ key: string; value: unknown }>;

  const rawAfter = Number.parseInt(cfgVal(rows, 'netopia_proxy_alert_after_s') ?? '', 10);
  const alertAfterS = Number.isFinite(rawAfter) ? Math.min(Math.max(rawAfter, 0), 86_400) : DEFAULT_ALERT_AFTER_S;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const watchdogLastAt = cfgVal(rows, 'netopia_proxy_watchdog_last_at') ?? '';
  const watchdogLastMs = Date.parse(watchdogLastAt);
  const watchdogFresh = Number.isFinite(watchdogLastMs) && nowMs - watchdogLastMs < WATCHDOG_STALE_MS;

  // ── Per-layer state machine: episode start, debounce, alert/recovery ──
  type AlertItem = { layer: LayerName; kind: 'down' | 'recovery'; state: LayerState; sinceIso: string; prev: string };
  const upserts: Array<{ key: string; value: unknown }> = [];
  const alertItems: AlertItem[] = [];

  for (const layer of LAYERS) {
    const state = layerReports[layer];
    if (!state) continue; // this reporter doesn't see this layer

    const prev = cfgVal(rows, `netopia_proxy_health_${layer}`) ?? 'unknown';
    const wasAlerted = cfgVal(rows, `netopia_proxy_health_${layer}_alerted`) === 'true';
    const storedSince = cfgVal(rows, `netopia_proxy_health_${layer}_since`) ?? '';

    if (state === 'ok') {
      if (wasAlerted) alertItems.push({ layer, kind: 'recovery', state, sinceIso: storedSince, prev });
      upserts.push(
        { key: `netopia_proxy_health_${layer}`, value: 'ok' },
        { key: `netopia_proxy_health_${layer}_since`, value: '' },
        { key: `netopia_proxy_health_${layer}_alerted`, value: 'false' },
      );
      continue;
    }

    // Non-ok: keep the episode start while the layer stays non-ok (a state
    // reclassification down<->upstream does NOT restart the clock); any ok
    // in between resets it — that's the de-flap.
    const continuing = prev !== 'ok' && prev !== 'unknown' && storedSince !== '';
    const sinceIso = continuing && Number.isFinite(Date.parse(storedSince)) ? storedSince : nowIso;
    const elapsedMs = nowMs - Date.parse(sinceIso);

    let shouldAlert = !wasAlerted && elapsedMs >= alertAfterS * 1000;
    if (layer === 'edge' && shouldAlert && watchdogFresh) {
      // Edge-only failure while the box itself reports fine → path noise
      // between the Supabase edge and the VPS. Record, never email.
      shouldAlert = false;
      console.log('[proxy-health] edge down suppressed (vps-watchdog fresh)', { npproxyHttp, sinceIso });
    }
    if (shouldAlert) alertItems.push({ layer, kind: 'down', state, sinceIso, prev });

    upserts.push(
      { key: `netopia_proxy_health_${layer}`, value: state },
      { key: `netopia_proxy_health_${layer}_since`, value: sinceIso },
      { key: `netopia_proxy_health_${layer}_alerted`, value: wasAlerted || shouldAlert ? 'true' : 'false' },
    );
  }

  // ── Legacy rollup key (back-compat: docs/queries read netopia_proxy_health) ──
  const layerNow: Record<LayerName, string> = { squid: 'unknown', npproxy: 'unknown', edge: 'unknown' };
  for (const layer of LAYERS) {
    layerNow[layer] = layerReports[layer] ?? cfgVal(rows, `netopia_proxy_health_${layer}`) ?? 'unknown';
  }
  const reported = Object.values(layerNow).filter((v): v is LayerState => sanitizeState(v) !== null);
  const rollup = reported.length ? reported.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'ok' as LayerState) : 'unknown';

  const detail = { source, squid_http: squidHttp, npproxy_http: npproxyHttp, layers: { ...layerReports }, at: nowIso, extra };
  upserts.push(
    { key: 'netopia_proxy_health', value: rollup },
    { key: 'netopia_proxy_health_at', value: nowIso },
    { key: 'netopia_proxy_health_detail', value: detail },
  );
  if (!isProbe) upserts.push({ key: 'netopia_proxy_watchdog_last_at', value: nowIso });

  await supabase.from('platform_config').upsert(upserts, { onConflict: 'key' });

  // ── One email per report, grouping every layer transition in it ──
  if (alertItems.length) {
    const downs = alertItems.filter((i) => i.kind === 'down');
    const worst = downs.slice().sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state])[0];
    const subject = worst
      ? `🔴 [TriciGo] Pagos NETOPIA: ${subjectFor(worst.layer, worst.state)}${downs.length > 1 ? ` (+${downs.length - 1})` : ''}`
      : `🟢 [TriciGo] Pagos NETOPIA: ${alertItems.map((i) => i.layer).join(', ')} recuperado`;

    const blocks = alertItems.map((i) => {
      const color = i.kind === 'down' ? '#dc2626' : '#059669';
      const title = i.kind === 'down'
        ? `${LAYER_LABEL[i.layer]} — ${i.state.toUpperCase()}`
        : `${LAYER_LABEL[i.layer]} — recuperado`;
      const text = i.kind === 'down'
        ? explainState(i.layer, i.state)
        : 'La capa volvió a responder con normalidad.';
      const sinceRow = i.sinceIso
        ? `<tr><td style="padding:4px 6px;color:#555">No-ok desde</td><td style="padding:4px 6px;text-align:right">${esc(i.sinceIso)}</td></tr>`
        : '';
      return `<h3 style="color:${color};margin:18px 0 6px">${esc(title)}</h3>
        <p style="margin:4px 0 8px">${esc(text)}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:4px 6px;color:#555">Estado</td><td style="padding:4px 6px;text-align:right">${esc(i.prev)} → <b>${esc(i.state)}</b></td></tr>
          ${sinceRow}
        </table>`;
    }).join('');

    const html = `<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">
      <h2 style="color:${worst ? '#dc2626' : '#059669'};border-bottom:2px solid ${worst ? '#dc2626' : '#059669'};padding-bottom:8px">
        ${worst ? 'Pagos NETOPIA: problema detectado' : 'Pagos NETOPIA: recuperado'}</h2>
      ${blocks}
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr><td style="padding:4px 6px;border-top:1px solid #eee;color:#555">Origen</td><td style="padding:4px 6px;border-top:1px solid #eee;text-align:right">${esc(source)}</td></tr>
        <tr><td style="padding:4px 6px;color:#555">squid HTTP</td><td style="padding:4px 6px;text-align:right">${esc(squidHttp || '—')}</td></tr>
        <tr><td style="padding:4px 6px;color:#555">np-proxy HTTP</td><td style="padding:4px 6px;text-align:right">${esc(npproxyHttp || '—')}</td></tr>
        <tr><td style="padding:4px 6px;color:#555">Fecha (UTC)</td><td style="padding:4px 6px;text-align:right">${esc(nowIso)}</td></tr>
      </table>
      <p style="color:#777;font-size:12px">Alerta automática del watchdog del proxy de pagos (debounce ${alertAfterS}s — netopia_proxy_alert_after_s). No responder.</p>
    </body></html>`;
    const to = cfgVal(rows, 'business_notification_email') ?? '';
    const recipients = to.split(',').map((s) => s.trim()).filter((s) => s.includes('@'));
    if (!recipients.length) {
      console.log('[proxy-health] no business email — skip alert');
    } else {
      try { await sendAlertEmail(recipients, subject, html); } catch (e) { console.error('[proxy-health] alert send failed', e); }
    }
  }

  return json(req, {
    ok: true,
    source,
    layers: layerReports,
    rollup,
    alerts: alertItems.map((i) => ({ layer: i.layer, kind: i.kind, state: i.state })),
  }, 200);
});
