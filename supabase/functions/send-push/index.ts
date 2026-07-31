// ============================================================
// supabase/functions/send-push/index.ts
//
// Sends Expo push notifications to users. Called from auto-admin
// (cron) and other server-side flows. Not invoked from any client
// app directly — all client-driven push notifications go through
// SECDEF RPCs that emit DB triggers, which then fire pg_net to
// this EF.
//
// BUG-182 fix: previously accepted any authenticated user's JWT
// and would happily send pushes to any `user_ids` array. A regular
// rider could call it to phish drivers or admins via the inbox
// (notifications table). Now requires service_role OR admin role.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS: restrict to allowed origins ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface PushRequest {
  user_id?: string;
  user_ids?: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
  category?: string;
}

// Curated list of valid notification categories. Kept in sync with
// the CHECK constraint added by migration 00333 on
// `notifications.type`. Any caller passing a value outside this set
// gets a 400 so contamination surfaces at the API edge instead of
// as a silent CHECK violation when send-push tries to insert.
//
// When adding a new category: (1) add it to this set, (2) extend
// the CHECK constraint via a follow-up migration, (3) update the
// driver/client notification handlers if it needs custom navigation.
const VALID_CATEGORIES = new Set([
  'ride',
  'ride_offer',
  'ride_matching',
  'chat',
  'proximity',
  'payment',
  'wallet_recharge',
  'wallet_recharge_refund',
  'wallet_credit',
  'wallet_debit',
  'scheduled_ride',
  'lost_item',
  'dispute_update',
  'sos',
  'delivery',
  'system',
  'promo',
  // Admin content notifications (00380): unblocks the "Notificar ahora"
  // buttons + notify-on-publish on the announcement/blog/promo admin
  // pages. broadcastToActiveUsers() forwards contentType verbatim as
  // the category, so these must be whitelisted or the EF 400s.
  'announcement',
  'blog',
  'news',
  'campaign',
  // Partner-place arrival coupons (00531 extends notifications_type_check to
  // match). Two senders: the issuance trigger in 00532 when a ride completes
  // at a partner business, and the 30-minutes-left reminder cron in 00534.
  //
  // ORDER MATTERS ON DEPLOY: 00534 stamps reminded_at optimistically the moment
  // it dispatches, because pg_net is async and delivery cannot be confirmed
  // synchronously. So a coupon whose push 400s here is burned permanently — it
  // never gets a second reminder. This EF must be deployed before any partner
  // place exists for a ride to complete at.
  'partner_coupon',
  // Legacy values kept for backward-compat with existing migrations.
  // TODO: consolidate `ride_updates` → `proximity` and remove
  // `wallet_v2_migration` after the one-shot migration RPC is dropped.
  'ride_updates',
  'wallet_v2_migration',
]);

// Which categories a user may opt out of, and the
// `notification_preferences` column that governs each.
//
// Until now this table was written by the apps and read by nobody: every
// push went to every token regardless of what the user had chosen. The
// settings screens looked like they worked because the value saved and
// reloaded correctly.
//
// This is an ALLOW-list, deliberately. Any category absent from it is
// always delivered — a notification system must fail toward delivering,
// never toward silence. The categories kept unconditional are the ones
// where dropping a message causes real harm:
//
//   ride_offer / ride_offer_launch  a driver's income depends on these
//   sos                             safety
//   dispute_update, lost_item       money and property already in dispute
//   delivery                        an in-flight package
//   system, wallet_v2_migration     operational / one-shot migrations
//
// `driver_approval` exists as a column but no caller ever sends that
// category, so it has nothing to map to.
const FILTERABLE_CATEGORY_TO_PREF: Record<string, string> = {
  // Ride lifecycle updates (not offers)
  ride: 'ride_updates',
  ride_matching: 'ride_updates',
  proximity: 'ride_updates',
  scheduled_ride: 'ride_updates',
  ride_updates: 'ride_updates',
  // Chat
  chat: 'chat_messages',
  // Money movements the user can already see in-app
  payment: 'payment_updates',
  wallet_recharge: 'payment_updates',
  wallet_recharge_refund: 'payment_updates',
  wallet_credit: 'payment_updates',
  wallet_debit: 'payment_updates',
  // Marketing / content
  promo: 'promotions',
  announcement: 'promotions',
  blog: 'promotions',
  news: 'promotions',
  campaign: 'promotions',
  // A partner coupon is something the passenger earned by paying for a ride,
  // which argues for delivering it unconditionally. But it is still a perk from
  // a business, and someone who switched promotions off has said they do not
  // want this. Honour that rather than reclassifying it to sneak past the
  // filter. The coupon itself is not lost — it waits in the app.
  partner_coupon: 'promotions',
};

/**
 * Drop users who opted out of this category.
 *
 * Fail-open by construction: a missing preferences row means the user
 * never changed anything (all defaults are true), and a query error
 * returns the list untouched. Only an explicit `false` removes anyone.
 */
async function filterByPreferences(
  supabase: ReturnType<typeof createClient>,
  userIds: string[],
  category: string | undefined,
): Promise<{ ids: string[]; skipped: number }> {
  const prefColumn = category ? FILTERABLE_CATEGORY_TO_PREF[category] : undefined;
  if (!prefColumn) return { ids: userIds, skipped: 0 };

  try {
    const { data, error } = await supabase
      .from('notification_preferences')
      .select(`user_id, ${prefColumn}`)
      .in('user_id', userIds);
    if (error) throw error;

    const optedOut = new Set(
      (data ?? [])
        .filter((row: Record<string, unknown>) => row[prefColumn] === false)
        .map((row: Record<string, unknown>) => row.user_id as string),
    );
    if (optedOut.size === 0) return { ids: userIds, skipped: 0 };

    const ids = userIds.filter((id) => !optedOut.has(id));
    return { ids, skipped: userIds.length - ids.length };
  } catch (err) {
    // Never let a preferences lookup stop a notification.
    console.warn(
      `[send-push] preference filter failed for category "${category}", delivering to all:`,
      (err as Error).message,
    );
    return { ids: userIds, skipped: 0 };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Rate limit: 30 requests per IP per minute
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-push:${clientIP}`, 30, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // ── Auth gate: service_role OR authenticated admin ──
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const apiKey = req.headers.get('apikey') ?? '';
    const isInternalCall = apiKey === serviceRoleKey;

    if (!isInternalCall) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'Missing authorization header' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
        authHeader.replace('Bearer ', ''),
      );
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      // Only admins can craft pushes for arbitrary user_ids.
      // Regular users have no legitimate path to call send-push.
      const { data: roleRow } = await supabaseAuth
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();
      if (!roleRow || !['admin', 'super_admin'].includes(roleRow.role as string)) {
        return new Response(
          JSON.stringify({ error: 'Forbidden: admin role required' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      serviceRoleKey,
    );

    const { user_id, user_ids, title, body, data, category } =
      (await req.json()) as PushRequest;

    // Support both single user_id and batch user_ids
    const targetIds: string[] = user_ids?.length
      ? user_ids
      : user_id
        ? [user_id]
        : [];

    if (targetIds.length === 0 || !title || !body) {
      return new Response(
        JSON.stringify({ error: 'user_id (or user_ids), title, and body are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Validate category against the curated list. The DB-side CHECK
    // (migration 00333) catches violations too, but failing here
    // gives a clean 400 with a specific error before we burn Expo
    // API calls on a payload the inbox would reject anyway.
    if (category && !VALID_CATEGORIES.has(category)) {
      return new Response(
        JSON.stringify({
          error: 'invalid_category',
          detail: `category "${category}" is not in the curated list. See VALID_CATEGORIES in send-push/index.ts.`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Honor the user's category preferences. `deliverIds` is used for
    // everything downstream — tokens AND the inbox row — because opting
    // out of a category means "don't send me this", not "send it quietly".
    const { ids: deliverIds, skipped: optedOutCount } =
      await filterByPreferences(supabase, targetIds, category);

    if (deliverIds.length === 0) {
      console.info(
        `[send-push] summary: sent=0 failed=0 total_tokens=0 targets=${targetIds.length}` +
        `${category ? ' category=' + category : ''} opted_out=${optedOutCount} (all recipients opted out)`,
      );
      return new Response(
        JSON.stringify({ sent: 0, failed: 0, total_tokens: 0, opted_out: optedOutCount }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch device tokens for the remaining users
    const { data: devices, error } = await supabase
      .from('user_devices')
      .select('push_token, platform')
      .in('user_id', deliverIds)
      .not('push_token', 'is', null);

    if (error) throw error;

    const deviceRows = (devices ?? []) as { push_token: string | null; platform: string | null }[];
    const tokens = deviceRows
      .map((d) => d.push_token)
      .filter(Boolean) as string[];
    const androidTokens = deviceRows
      .filter((d) => d.push_token && d.platform === 'android')
      .map((d) => d.push_token) as string[];

    if (tokens.length === 0) {
      // Still persist to inbox even if no push tokens (user can see in-app)
      try {
        const inboxData = {
          ...(data ?? {}),
          ...(category ? { type: category } : {}),
        };
        const notifRows = deliverIds.map((uid: string) => ({
          user_id: uid,
          type: category ?? 'system',
          title,
          body,
          data: Object.keys(inboxData).length > 0 ? inboxData : null,
        }));
        await supabase.from('notifications').insert(notifRows);
      } catch (inboxErr) {
        console.warn('[send-push] Failed to persist to inbox:', (inboxErr as Error).message);
      }

      return new Response(
        JSON.stringify({ message: 'No devices found', sent: 0, failed: 0, opted_out: optedOutCount }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Merge category into data payload if provided
    const pushData = {
      ...(data ?? {}),
      ...(category ? { type: category } : {}),
    };

    // Send via Expo push API — one request per token. Tokens can belong to
    // different Expo projects (the client and driver are separate Expo apps),
    // and Expo rejects a batch that mixes experience IDs with a 400
    // (PUSH_TOO_MANY_EXPERIENCE_IDS). One token per request keeps each call to a
    // single project so multi-app users still get notified.
    let sent = 0;
    let failed = 0;
    const deadTokens: string[] = [];
    // Collected for the per-invocation summary log below. Without this,
    // a delivery outage (e.g. InvalidCredentials when FCM creds are
    // missing) is invisible unless you eyeball every per-token line.
    const errorCodes: string[] = [];

    await Promise.all(tokens.map(async (token: string) => {
      try {
        const pushResponse = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: token,
            title,
            body,
            sound: 'default' as const,
            // FCM high priority: wakes the device and shows a heads-up
            // notification even when the app is in Doze / killed.
            priority: 'high' as const,
            // Android: route to the high-importance 'rides' channel both
            // apps create (driver: useNotifications.ts, client:
            // push.service.ts). Without this, killed-app pushes land on
            // the low-importance default channel and stay silent. iOS
            // ignores channelId.
            channelId: 'rides',
            badge: 1,
            ...(Object.keys(pushData).length > 0 ? { data: pushData } : {}),
          }),
        });

        if (!pushResponse.ok) {
          failed++;
          const errBody = await pushResponse.text().catch(() => '');
          console.warn(`[send-push] Expo push API returned status ${pushResponse.status}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`);
          return;
        }

        const pushResult = await pushResponse.json();
        // Single-message POST → `data` is one ticket object; array → array.
        const ticket = Array.isArray(pushResult.data) ? pushResult.data[0] : pushResult.data;
        if (ticket?.status === 'ok') {
          sent++;
          return;
        }
        failed++;
        const errCode = ticket?.details?.error;
        if (errCode) errorCodes.push(errCode);
        if (errCode === 'DeviceNotRegistered') {
          // The user uninstalled the app, disabled notifications, or the token
          // rotated. Drop the dead row so future pushes don't waste API calls.
          deadTokens.push(token);
        } else if (errCode === 'InvalidCredentials') {
          console.error('[send-push] InvalidCredentials from Expo — FCM/APNs creds need to be re-uploaded in eas credentials');
        } else if (errCode) {
          console.warn(`[send-push] Expo ticket error: ${errCode}${ticket?.message ? ' — ' + ticket.message : ''}`);
        }
      } catch (sendErr) {
        failed++;
        console.warn('[send-push] Failed to send push:', (sendErr as Error).message);
      }
    }));

    // Ride offers: additionally send a DATA-ONLY, high-priority message to
    // Android devices. No title/body → Expo delivers it as an FCM data
    // message, which shows nothing but wakes the driver app's background
    // task ('ride-offer-launch-task', apps/driver/src/tasks/
    // rideOfferLaunchTask.ts) so it can bring the app to the foreground —
    // the Realtime-WebSocket launch path (PR #807) loses the race against
    // FCM in background and drops silently when the channel dies.
    // Old builds without the task ignore this message; the visible offer
    // push above remains their UX. Best-effort: launch failures never
    // affect the visible push outcome, and no extra inbox row is written.
    let launchSent = 0;
    if (category === 'ride_offer' && androidTokens.length > 0) {
      await Promise.all(androidTokens.map(async (token: string) => {
        try {
          const launchResponse = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to: token,
              priority: 'high' as const,
              data: { ...pushData, type: 'ride_offer_launch' },
            }),
          });
          if (!launchResponse.ok) return;
          const launchResult = await launchResponse.json();
          const launchTicket = Array.isArray(launchResult.data) ? launchResult.data[0] : launchResult.data;
          if (launchTicket?.status === 'ok') launchSent++;
        } catch { /* best-effort — visible push already covers the driver */ }
      }));
    }

    if (deadTokens.length > 0) {
      const { error: cleanupErr } = await supabase
        .from('user_devices')
        .delete()
        .in('push_token', deadTokens);
      if (cleanupErr) {
        console.warn('[send-push] Failed to clean dead tokens:', cleanupErr.message);
      } else {
        console.info(`[send-push] Cleaned ${deadTokens.length} dead token(s) from user_devices`);
      }
    }

    // Persist to in-app notification inbox for each delivered user
    try {
      const notifRows = deliverIds.map((uid: string) => ({
        user_id: uid,
        type: category ?? 'system',
        title,
        body,
        data: Object.keys(pushData).length > 0 ? pushData : null,
      }));
      await supabase.from('notifications').insert(notifRows);
    } catch (inboxErr) {
      // Non-critical: push was already sent, inbox persistence is best-effort
      console.warn('[send-push] Failed to persist to inbox:', (inboxErr as Error).message);
    }

    // Always emit a one-line summary so delivery outcomes are visible in
    // the function logs (the {sent,failed} body alone never reaches them).
    console.info(
      `[send-push] summary: sent=${sent} failed=${failed} total_tokens=${tokens.length}` +
      `${errorCodes.length ? ' errors=' + [...new Set(errorCodes)].join(',') : ''}` +
      ` targets=${targetIds.length}${category ? ' category=' + category : ''}` +
      `${optedOutCount > 0 ? ` opted_out=${optedOutCount}` : ''}` +
      `${category === 'ride_offer' ? ` launch_sent=${launchSent}/${androidTokens.length}` : ''}`,
    );

    return new Response(
      JSON.stringify({ sent, failed, total_tokens: tokens.length, opted_out: optedOutCount }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
