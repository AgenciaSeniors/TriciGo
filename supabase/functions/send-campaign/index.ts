// ============================================================
// supabase/functions/send-campaign/index.ts
//
// The only sender of admin campaigns (00649). Two callers:
//   - the panel, right after inserting a campaign with "Enviar ahora":
//       { campaign_id }   (an admin, or marketing for a campaign its own account created)
//   - the cron job send-due-campaigns (dispatch_due_campaigns), with the service key:
//       { due: true }     claims up to 5 due campaigns, answers 202 at once and sends them in the
//                         background, so pg_net's 30 s timeout never cuts the call.
//
// A campaign is claimed (scheduled -> sending) by claim_campaigns, one statement with
// FOR UPDATE SKIP LOCKED, so the button and the cron never send it twice. The recipients come
// from campaign_recipient_ids (SQL, at send time). Push and e-mail go through the existing
// send-push and send-bulk-email with the service key; their own rules (notification preferences,
// marketing consent, proven addresses) still apply.
// ============================================================
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey, isServiceKeyToken } from '../_shared/service-key.ts';
import { isAdminRole, isPanelStaffRole } from '../_shared/panel-roles.ts';
import { campaignEmailHtml, campaignOutcome, type ChannelResult } from '../_shared/campaign-send.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const DUE_BATCH = 5;
// Same cap as campaignOutcome's last_error.
const MAX_ERROR = 500;

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface Campaign {
  id: string;
  channel: string;
  message_title: string;
  message_body: string;
  promo_code_id: string | null;
  created_by: string | null;
}

// Supabase's background-task API; absent in tests and older runtimes.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Untyped client, as in create-netopia-payment-intent. ReturnType<typeof createClient> would pin the
// generics to their constraints and reject rpc arguments and update rows on untyped tables.
type Client = SupabaseClient;

async function callChannel(
  channel: 'push' | 'email',
  url: string,
  serviceKey: string,
  payload: Record<string, unknown>,
): Promise<ChannelResult> {
  const fn = channel === 'push' ? 'send-push' : 'send-bulk-email';
  try {
    const res = await fetch(`${url}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { sent?: number; error?: string };
    if (!res.ok) return { channel, ok: false, sent: 0, error: json.error ?? `HTTP ${res.status}` };
    return { channel, ok: true, sent: Number(json.sent ?? 0) };
  } catch (err) {
    return { channel, ok: false, sent: 0, error: (err as Error).message };
  }
}

async function sendCampaign(client: Client, url: string, serviceKey: string, c: Campaign) {
  const results: ChannelResult[] = [];
  let recipientError: string | undefined;
  let ids: string[] = [];

  const { data, error } = await client.rpc('campaign_recipient_ids', { p_campaign_id: c.id });
  if (error) {
    recipientError = `recipients: ${error.message}`;
  } else {
    ids = Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
  }

  if (!recipientError && ids.length > 0) {
    if (c.channel === 'push' || c.channel === 'both') {
      results.push(await callChannel('push', url, serviceKey, {
        user_ids: ids,
        title: c.message_title,
        body: c.message_body,
        category: 'campaign',
        data: { deep_link: 'tricigo://home', content_type: 'campaign', content_id: c.id },
      }));
    }
    if (c.channel === 'email' || c.channel === 'both') {
      results.push(await callChannel('email', url, serviceKey, {
        user_ids: ids,
        subject: c.message_title,
        body_html: campaignEmailHtml(c.message_body),
        promo_code_id: c.promo_code_id,
      }));
    }
  }

  const outcome = campaignOutcome(results, recipientError);
  const row = {
    status: outcome.status,
    recipient_count: ids.length,
    push_sent: outcome.pushSent,
    email_sent: outcome.emailSent,
    sent_count: outcome.sentCount,
    last_error: outcome.lastError,
    sent_at: new Date().toISOString(),
  };
  const { error: updateError } = await client.from('campaigns').update(row).eq('id', c.id).eq('status', 'sending');
  if (updateError) console.error('[send-campaign] could not record the result', c.id, updateError.message);
  console.info(
    `[send-campaign] ${c.id}: ${outcome.status} recipients=${ids.length} push=${outcome.pushSent} email=${outcome.emailSent}` +
      (outcome.lastError ? ` error=${outcome.lastError}` : ''),
  );
  return { id: c.id, ...row, channels: results };
}

/**
 * sendCampaign, but an unexpected throw marks that campaign 'failed' instead of leaving it in
 * 'sending' or stopping the rest of a due batch. The write keeps the 'sending' filter, like
 * sendCampaign's, so it never overwrites what the stuck-send sweep already recorded.
 */
async function sendCampaignSafely(client: Client, url: string, serviceKey: string, c: Campaign) {
  try {
    return await sendCampaign(client, url, serviceKey, c);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const row = {
      status: 'failed' as const,
      recipient_count: 0,
      push_sent: 0,
      email_sent: 0,
      sent_count: 0,
      last_error: `unexpected: ${message}`.slice(0, MAX_ERROR),
      sent_at: new Date().toISOString(),
    };
    console.error('[send-campaign] unexpected error, marking the campaign failed', c.id, err);
    try {
      const { error: updateError } = await client
        .from('campaigns')
        .update({ status: row.status, last_error: row.last_error, sent_at: row.sent_at })
        .eq('id', c.id)
        .eq('status', 'sending');
      if (updateError) console.error('[send-campaign] could not record the failure', c.id, updateError.message);
    } catch (writeErr) {
      console.error('[send-campaign] could not record the failure', c.id, writeErr);
    }
    return { id: c.id, ...row, channels: [] as ChannelResult[] };
  }
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const serviceKey = getServiceKey();
    const url = Deno.env.get('SUPABASE_URL')!;
    const client = createClient(url, serviceKey);
    const isInternal = isServiceKeyToken(req.headers.get('apikey') ?? '');

    let callerId: string | null = null;
    let callerRole: string | null = null;
    if (!isInternal) {
      const auth = req.headers.get('Authorization');
      if (!auth?.startsWith('Bearer ')) return json(401, { error: 'Missing authorization header' });
      const { data: { user }, error } = await client.auth.getUser(auth.replace('Bearer ', ''));
      if (error || !user) return json(401, { error: 'Invalid or expired token' });
      const { data: roleRow } = await client.from('users').select('role').eq('id', user.id).single();
      callerRole = (roleRow?.role as string | undefined) ?? null;
      if (!isPanelStaffRole(callerRole)) return json(403, { error: 'Forbidden: panel role required' });
      callerId = user.id;
    }

    const body = (await req.json().catch(() => ({}))) as { due?: unknown; campaign_id?: unknown };

    if (body.due === true) {
      if (!isInternal) return json(403, { error: 'Forbidden: due runs need the service key' });
      const { data, error } = await client.rpc('claim_campaigns', { p_campaign_id: null, p_limit: DUE_BATCH });
      if (error) throw new Error(error.message);
      const claimed = (data ?? []) as Campaign[];
      const work = (async () => {
        for (const c of claimed) await sendCampaignSafely(client, url, serviceKey, c);
      })();
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
      else await work;
      return json(202, { claimed: claimed.map((c) => c.id) });
    }

    const campaignId = typeof body.campaign_id === 'string' ? body.campaign_id : null;
    if (!campaignId) return json(400, { error: 'campaign_id required' });

    if (!isInternal && !isAdminRole(callerRole)) {
      const { data: own } = await client.from('campaigns').select('created_by').eq('id', campaignId).single();
      if (!own || (own as { created_by: string | null }).created_by !== callerId) {
        return json(403, { error: 'Forbidden: not your campaign' });
      }
    }

    const { data, error } = await client.rpc('claim_campaigns', { p_campaign_id: campaignId, p_limit: 1 });
    if (error) throw new Error(error.message);
    const claimed = (data ?? []) as Campaign[];
    if (claimed.length === 0) {
      const { data: row } = await client.from('campaigns').select('status').eq('id', campaignId).single();
      return json(409, { error: 'not_claimable', status: (row as { status?: string } | null)?.status ?? null });
    }
    return json(200, await sendCampaignSafely(client, url, serviceKey, claimed[0]));
  } catch (err) {
    console.error('[send-campaign]', err);
    return json(500, { error: 'internal' });
  }
});
