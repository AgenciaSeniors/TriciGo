// ============================================================
// supabase/functions/send-team-digest/index.ts
//
// The team daily digest sender (00656). The cron job send-team-digest runs dispatch_team_digest()
// every hour; at 7–8 Havana time, with team_digest_enabled on and the day not sent yet, it calls
// this function with the service key and { day: 'YYYY-MM-DD' }. This function answers 202 at once
// and, in the background (EdgeRuntime.waitUntil):
//   1. reads the numbers (team_daily_metrics) and the recipients (team_digest_recipients). A read
//      that fails claims nothing, so the day stays open and the 08:05 dispatch tries again;
//   2. claims the day (claim_team_digest: one winner; a lost claim sends nothing). Nothing is sent
//      before the claim, so only one run can send;
//   3. renders each person's version (marketing without money) and sends it through send-email,
//      one at a time, as raw HTML, with a 20 s timeout and one retry about 1 s later. Each person
//      is in their own try: a failure, or an exception in their token or render, counts as failed
//      and the loop goes on;
//   4. records the outcome (finish_team_digest), also with nobody to send to. A run that dies
//      before this stays 'sending' and becomes 'failed' 30 minutes later;
//      check_team_digest_overdue alerts after 9:00.
//
// The e-mail goes through send-email's raw-HTML path: `template` is the rendered HTML (never a
// registry key or a bare slug, which send-email rejects), `subject` is set (required on that
// path) and `data` is empty, so send-email substitutes no {{placeholders}}. Addresses and
// unsubscribe tokens are never logged; failures are recorded by account id.
// ============================================================
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey, isServiceKeyToken } from '../_shared/service-key.ts';
import { WEB_ORIGIN } from '../_shared/brand.ts';
import { digestSecret, havanaYesterday, isValidDay, unsubscribeToken, unsubscribeUrl } from '../_shared/team-digest.ts';
import {
  teamDailyDigestHtml,
  teamDailyDigestSubject,
  type TeamDigestMetrics,
} from '../_shared/email-templates/team_daily_digest.ts';

const PANEL_URL = 'https://admin.tricigo.com';
const MAX_ERROR = 500;
/** One send-email call. Two attempts plus the wait stay under a minute per person. */
const SEND_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

// Supabase's background-task API; absent in tests.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

interface Recipient {
  user_id: string;
  role: string;
  email: string;
  full_name: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timeout' : err.message;
  return String(err);
}

/**
 * The wait before the retry. TEAM_DIGEST_RETRY_DELAY_MS exists so the tests can make it 0;
 * production does not set it and waits DEFAULT_RETRY_DELAY_MS.
 */
function retryDelayMs(): number {
  const raw = Deno.env.get('TEAM_DIGEST_RETRY_DELAY_MS');
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : DEFAULT_RETRY_DELAY_MS;
}

/** One send-email call. null when it accepted the e-mail, else the reason. Never throws. */
async function attemptSend(url: string, serviceKey: string, to: string, subject: string, html: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ template: html, data: {}, recipient_email: to, subject }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Up to two attempts, about a second apart. A first attempt that timed out may still have been
 * delivered, so a retry can, rarely, send the same e-mail twice; one extra e-mail beats none.
 */
async function sendWithRetry(url: string, serviceKey: string, to: string, subject: string, html: string): Promise<string | null> {
  const first = await attemptSend(url, serviceKey, to, subject, html);
  if (first === null) return null;
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs()));
  return await attemptSend(url, serviceKey, to, subject, html);
}

async function runDigest(client: SupabaseClient, url: string, serviceKey: string, day: string): Promise<void> {
  // 1. Read. Nothing is claimed yet: a failed read leaves the day for the next dispatch.
  const metrics = await client.rpc('team_daily_metrics', { p_day: day });
  if (metrics.error) {
    console.error(`[send-team-digest] ${day}: could not read the numbers, nothing claimed`, metrics.error.message);
    return;
  }
  const data = metrics.data as TeamDigestMetrics | null;
  if (!data?.current) {
    console.error(`[send-team-digest] ${day}: the numbers have an unexpected shape, nothing claimed`);
    return;
  }
  const list = await client.rpc('team_digest_recipients');
  if (list.error) {
    console.error(`[send-team-digest] ${day}: could not read the recipients, nothing claimed`, list.error.message);
    return;
  }
  const recipients = (Array.isArray(list.data) ? list.data : []) as Recipient[];

  // 2. Claim: one winner per day.
  const claim = await client.rpc('claim_team_digest', { p_day: day });
  if (claim.error) {
    console.error(`[send-team-digest] ${day}: claim failed`, claim.error.message);
    return;
  }
  if (claim.data !== true) {
    console.info(`[send-team-digest] ${day}: already claimed, nothing to do`);
    return;
  }

  // 3. Send, one person at a time; one person's failure never stops the others.
  let sent = 0;
  let failed = 0;
  let error: string | null = null;
  try {
    const secret = digestSecret((name) => Deno.env.get(name), serviceKey);
    const subject = teamDailyDigestSubject(day);
    for (const r of recipients) {
      let failure: string | null;
      try {
        const token = await unsubscribeToken(secret, r.user_id);
        const html = teamDailyDigestHtml({
          role: r.role,
          name: r.full_name,
          metrics: data,
          panel_url: PANEL_URL,
          unsubscribe_url: unsubscribeUrl(WEB_ORIGIN, r.user_id, token),
        });
        failure = await sendWithRetry(url, serviceKey, r.email, subject, html);
      } catch (err) {
        failure = errorMessage(err);
      }
      if (failure) {
        failed += 1;
        error = `${r.user_id}: ${failure}`.slice(0, MAX_ERROR);
        console.error(`[send-team-digest] ${day}: not sent to ${error}`);
      } else {
        sent += 1;
      }
    }
  } catch (err) {
    // Outside the per-person try (the secret or the subject): the run is still recorded below.
    error = errorMessage(err).slice(0, MAX_ERROR);
  }

  // 4. Record the outcome. The SQL marks a run that sent nothing as failed (also 'no_recipients').
  const finish = await client.rpc('finish_team_digest', {
    p_day: day,
    p_recipients: recipients.length,
    p_sent: sent,
    p_failed: failed,
    p_error: error,
  });
  const summary = `recipients=${recipients.length} sent=${sent} failed=${failed}` + (error ? ` error=${error}` : '');
  if (finish.error) {
    console.error(`[send-team-digest] ${day}: could not record the result (${summary})`, finish.error.message);
  } else if (finish.data !== true) {
    console.warn(
      `[send-team-digest] ${day}: result not recorded: the run is no longer 'sending' ` +
        `(already marked failed/interrupted after 30 minutes). What was sent: ${summary}`,
    );
  }
  console.info(`[send-team-digest] ${day}: ${summary}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!isServiceKeyToken(req.headers.get('apikey') ?? '') && !isServiceKeyToken(bearer)) {
    return json(401, { error: 'Forbidden: service key required' });
  }

  try {
    // A missing, empty or null body means "the Havana day before"; anything else must be a JSON
    // object, so a malformed call never claims a day by accident.
    const text = await req.text();
    let raw: unknown = null;
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return json(400, { error: 'body must be JSON' });
      }
    }
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      return json(400, { error: 'body must be a JSON object' });
    }
    const body = (raw ?? {}) as { day?: unknown };

    const yesterday = havanaYesterday(new Date());
    const day = body.day === undefined || body.day === null ? yesterday : body.day;
    if (typeof day !== 'string' || !isValidDay(day)) return json(400, { error: 'day must be a real YYYY-MM-DD date' });
    // A claimed day is never sent again: a day still in progress (or in the future) would block
    // its real run.
    if (day > yesterday) return json(400, { error: 'day must not be after the Havana day before today' });

    const serviceKey = getServiceKey();
    const url = Deno.env.get('SUPABASE_URL')!;
    const client = createClient(url, serviceKey);
    const work = runDigest(client, url, serviceKey, day).catch((err) => {
      console.error(`[send-team-digest] ${day}: unexpected error`, errorMessage(err));
    });
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
    else await work;
    return json(202, { accepted: true, day });
  } catch (err) {
    console.error('[send-team-digest]', errorMessage(err));
    return json(500, { error: 'internal' });
  }
});
