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

    // Send via Expo push API
    const messages = tokens.map((token) => ({
      to: token,
      title,
      body,
      sound: 'default' as const,
      badge: 1,
      ...(Object.keys(pushData).length > 0 ? { data: pushData } : {}),
    }));

    const pushResponse = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });

    const pushResult = await pushResponse.json();

    let sent = 0;
    let failed = 0;
    const deadTokens: string[] = [];
    if (Array.isArray(pushResult.data)) {
      pushResult.data.forEach((ticket: { status?: string; message?: string; details?: { error?: string } }, idx: number) => {
        if (ticket.status === 'ok') {
          sent++;
          return;
        }
        failed++;
        const errCode = ticket.details?.error;
        const tokenForTicket = tokens[idx];
        if (errCode === 'DeviceNotRegistered' && tokenForTicket) {
          // The user uninstalled the app, disabled notifications, or
          // the token rotated. Drop the dead row so future pushes don't
          // waste Expo API calls on it.
          deadTokens.push(tokenForTicket);
        } else if (errCode === 'InvalidCredentials') {
          console.error('[send-push] InvalidCredentials from Expo — FCM/APNs creds need to be re-uploaded in eas credentials');
        } else if (errCode) {
          console.warn(`[send-push] Expo ticket error: ${errCode}${ticket.message ? ' — ' + ticket.message : ''}`);
        }
      });
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
