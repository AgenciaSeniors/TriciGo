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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
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
  // Legacy values kept for backward-compat with existing migrations.
  // TODO: consolidate `ride_updates` → `proximity` and remove
  // `wallet_v2_migration` after the one-shot migration RPC is dropped.
  'ride_updates',
  'wallet_v2_migration',
]);

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

    // Fetch device tokens for all target users
    const { data: devices, error } = await supabase
      .from('user_devices')
      .select('push_token')
      .in('user_id', targetIds)
      .not('push_token', 'is', null);

    if (error) throw error;

    const tokens = (devices ?? [])
      .map((d: { push_token: string | null }) => d.push_token)
      .filter(Boolean) as string[];

    if (tokens.length === 0) {
      // Still persist to inbox even if no push tokens (user can see in-app)
      try {
        const inboxData = {
          ...(data ?? {}),
          ...(category ? { type: category } : {}),
        };
        const notifRows = targetIds.map((uid: string) => ({
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
        JSON.stringify({ message: 'No devices found', sent: 0, failed: 0 }),
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

    // Persist to in-app notification inbox for each target user
    try {
      const notifRows = targetIds.map((uid: string) => ({
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
      ` targets=${targetIds.length}${category ? ' category=' + category : ''}`,
    );

    return new Response(
      JSON.stringify({ sent, failed, total_tokens: tokens.length }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
