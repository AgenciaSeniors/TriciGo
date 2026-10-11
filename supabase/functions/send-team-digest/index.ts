// ============================================================
// supabase/functions/send-team-digest/index.ts
//
// The team daily digest sender (00656). The cron job send-team-digest runs dispatch_team_digest()
// every hour; at 7–8 Havana time, with team_digest_enabled on and the day not sent yet, it calls
// this function with the service key and { day: 'YYYY-MM-DD' }. This function answers 202 at once
// and, in the background (EdgeRuntime.waitUntil):
//   1. claims the day (claim_team_digest: one winner; a lost claim sends nothing),
//   2. reads the numbers (team_daily_metrics) and the recipients (team_digest_recipients),
//   3. renders each person's version (marketing without money) and sends it through send-email,
//      one at a time, as raw HTML; one failed address does not stop the rest,
//   4. records the outcome (finish_team_digest). A run that dies before this stays 'sending' and
//      becomes 'failed' 30 minutes later; check_team_digest_overdue alerts after 9:00.
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

// Supabase's background-task API; absent in tests.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

interface Recipient {
  user_id: string;
  role: string;
  email: string;
  full_name: string;
}

/** null when send-email accepted it, else the reason. Never throws. */
async function sendOne(url: string, serviceKey: string, to: string, subject: string, html: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/functions/v1/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ template: html, data: {}, recipient_email: to, subject }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function runDigest(client: SupabaseClient, url: string, serviceKey: string, day: string): Promise<void> {
  const claim = await client.rpc('claim_team_digest', { p_day: day });
  if (claim.error) {
    console.error(`[send-team-digest] ${day}: claim failed`, claim.error.message);
    return;
  }
  if (claim.data !== true) {
    console.info(`[send-team-digest] ${day}: already claimed, nothing to do`);
    return;
  }

  let recipients: Recipient[] = [];
  let sent = 0;
  let failed = 0;
  let error: string | null = null;
  try {
    const metrics = await client.rpc('team_daily_metrics', { p_day: day });
    if (metrics.error) throw new Error(`metrics: ${metrics.error.message}`);
    const data = metrics.data as TeamDigestMetrics | null;
    if (!data?.current) throw new Error('metrics: unexpected shape');
    const list = await client.rpc('team_digest_recipients');
    if (list.error) throw new Error(`recipients: ${list.error.message}`);
    recipients = (list.data ?? []) as Recipient[];

    const secret = digestSecret((name) => Deno.env.get(name), serviceKey);
    const subject = teamDailyDigestSubject(day);
    for (const r of recipients) {
      const token = await unsubscribeToken(secret, r.user_id);
      const html = teamDailyDigestHtml({
        role: r.role,
        name: r.full_name,
        metrics: data,
        panel_url: PANEL_URL,
        unsubscribe_url: unsubscribeUrl(WEB_ORIGIN, r.user_id, token),
      });
      const failure = await sendOne(url, serviceKey, r.email, subject, html);
      if (failure) {
        failed += 1;
        error = `${r.user_id}: ${failure}`.slice(0, MAX_ERROR);
      } else {
        sent += 1;
      }
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR);
  }

  const finish = await client.rpc('finish_team_digest', {
    p_day: day,
    p_recipients: recipients.length,
    p_sent: sent,
    p_failed: failed,
    p_error: error,
  });
  if (finish.error) console.error(`[send-team-digest] ${day}: could not record the result`, finish.error.message);
  console.info(
    `[send-team-digest] ${day}: recipients=${recipients.length} sent=${sent} failed=${failed}` + (error ? ` error=${error}` : ''),
  );
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
    const raw: unknown = await req.json().catch(() => null);
    const body = (raw && typeof raw === 'object' ? raw : {}) as { day?: unknown };
    // No day (or null): the Havana day before. Anything else must be a real date: a malformed
    // day must not quietly claim yesterday, since a claimed day is never sent again.
    const day = body.day === undefined || body.day === null ? havanaYesterday(new Date()) : body.day;
    if (typeof day !== 'string' || !isValidDay(day)) return json(400, { error: 'day must be a real YYYY-MM-DD date' });

    const serviceKey = getServiceKey();
    const url = Deno.env.get('SUPABASE_URL')!;
    const client = createClient(url, serviceKey);
    const work = runDigest(client, url, serviceKey, day).catch((err) => {
      console.error(`[send-team-digest] ${day}: unexpected error`, err instanceof Error ? err.message : String(err));
    });
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
    else await work;
    return json(202, { accepted: true, day });
  } catch (err) {
    console.error('[send-team-digest]', err instanceof Error ? err.message : String(err));
    return json(500, { error: 'internal' });
  }
});
