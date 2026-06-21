// ============================================================
// TriciGo — Behavioral Emails Edge Function
// Runs daily via pg_cron to send automated emails:
//   - Welcome email: users registered in the last 24 hours
//   - Win-back email: users whose last ride was 7+ days ago
//
// Uses the send-email function to render and deliver emails
// via Resend. Tracks sends in the email_sends table to avoid
// duplicate deliveries.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function getSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// ── Send email via the send-email Edge Function ──
async function sendEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  recipient_email: string,
  subject: string,
  template: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({ template, data, recipient_email, subject }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[behavioral-emails] send-email error for ${recipient_email}:`, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[behavioral-emails] Failed to call send-email:`, err);
    return false;
  }
}

// ── Track that an email was sent ──
async function trackSend(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  template: string,
): Promise<void> {
  const { error } = await supabase
    .from('email_sends')
    .insert({ user_id: userId, template });
  if (error) {
    console.error(`[behavioral-emails] Failed to track send for ${userId}/${template}:`, error.message);
  }
}

// ── Job A: Welcome email for new users (registered in last 24h) ──
async function processWelcomeEmails(supabase: ReturnType<typeof getSupabase>): Promise<number> {
  const cutoff = new Date(Date.now() - 86400000).toISOString(); // 24 hours ago

  // Find new users who haven't received a welcome email yet
  const { data: newUsers, error: usersError } = await supabase
    .from('users')
    .select('id, email, full_name')
    .gte('created_at', cutoff);

  if (usersError) {
    console.error('[behavioral-emails] Error fetching new users:', usersError.message);
    return 0;
  }
  if (!newUsers?.length) return 0;

  // Get users who already received a welcome email
  const userIds = newUsers.map((u: { id: string }) => u.id);
  const { data: alreadySent } = await supabase
    .from('email_sends')
    .select('user_id')
    .in('user_id', userIds)
    .eq('template', 'welcome');

  const sentSet = new Set((alreadySent ?? []).map((r: { user_id: string }) => r.user_id));

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let count = 0;
  for (const user of newUsers) {
    if (sentSet.has(user.id)) continue;
    if (!user.email) continue;

    const ok = await sendEmail(
      supabaseUrl,
      serviceRoleKey,
      user.email,
      '\u00a1Bienvenido a TriciGo!',
      'welcome',
      { full_name: user.full_name ?? '' },
    );

    if (ok) {
      await trackSend(supabase, user.id, 'welcome');
      count++;
    }
  }

  return count;
}

// ── Job B: Win-back email for inactive users (last ride 7+ days ago) ──
async function processWinBackEmails(supabase: ReturnType<typeof getSupabase>): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  // "Inactive" = a customer with a completed ride, but none in the last 7
  // days. Aggregated in-memory from the rides table — no dedicated RPC
  // needed at current volume.
  return await processWinBackInactive(supabase, sevenDaysAgo);
}

async function processWinBackInactive(
  supabase: ReturnType<typeof getSupabase>,
  sevenDaysAgo: string,
): Promise<number> {
  // Customers who completed a ride within the last 7 days — excluded below.
  const { data: recentRiders } = await supabase
    .from('rides')
    .select('customer_id')
    .eq('status', 'completed')
    .gte('completed_at', sevenDaysAgo);

  const recentRiderIds = new Set((recentRiders ?? []).map((r: { customer_id: string }) => r.customer_id));

  // Customers with older completed rides (newest first).
  const { data: allRiders } = await supabase
    .from('rides')
    .select('customer_id, completed_at')
    .eq('status', 'completed')
    .lt('completed_at', sevenDaysAgo)
    .order('completed_at', { ascending: false });

  if (!allRiders?.length) return 0;

  // Deduplicate: keep only the most recent ride per customer, skipping
  // anyone who also has a ride within the last 7 days.
  const latestByRider = new Map<string, { customer_id: string; completed_at: string }>();
  for (const ride of allRiders) {
    if (!latestByRider.has(ride.customer_id) && !recentRiderIds.has(ride.customer_id)) {
      latestByRider.set(ride.customer_id, ride);
    }
  }

  if (latestByRider.size === 0) return 0;

  // Resolve user records (name + email) for the inactive customers.
  const riderIds = Array.from(latestByRider.keys());
  const { data: profiles } = await supabase
    .from('users')
    .select('id, email, full_name')
    .in('id', riderIds);

  if (!profiles?.length) return 0;

  // Attach days info
  const usersWithDays = profiles.map((p: { id: string; email: string; full_name: string }) => {
    const ride = latestByRider.get(p.id);
    const daysSince = ride
      ? Math.floor((Date.now() - new Date(ride.completed_at).getTime()) / 86400000)
      : 7;
    return { ...p, days_since_last_ride: daysSince };
  });

  return await sendWinBackBatch(supabase, usersWithDays);
}

async function sendWinBackBatch(
  supabase: ReturnType<typeof getSupabase>,
  users: Array<{ id: string; email: string; full_name: string; days_since_last_ride?: number }>,
): Promise<number> {
  const userIds = users.map(u => u.id);

  // Filter out users who already received a win_back email in the last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: alreadySent } = await supabase
    .from('email_sends')
    .select('user_id')
    .in('user_id', userIds)
    .eq('template', 'win_back')
    .gte('sent_at', thirtyDaysAgo);

  const sentSet = new Set((alreadySent ?? []).map((r: { user_id: string }) => r.user_id));

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let count = 0;
  for (const user of users) {
    if (sentSet.has(user.id)) continue;
    if (!user.email) continue;

    const days = user.days_since_last_ride ?? 7;

    const ok = await sendEmail(
      supabaseUrl,
      serviceRoleKey,
      user.email,
      '\u00a1Te extra\u00f1amos! Vuelve a viajar con TriciGo',
      'win_back',
      { full_name: user.full_name ?? '', days_since_last_ride: days },
    );

    if (ok) {
      await trackSend(supabase, user.id, 'win_back');
      count++;
    }
  }

  return count;
}

// ── Main handler ──
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // BUG-036 + BUG-199: cron auth. The pg_cron job presents the service-role key
  // in the `apikey` header (Authorization carries only the anon JWT), so the old
  // `authHeader.includes(SERVICE_ROLE_KEY)` check ALWAYS failed and every daily
  // run 401'd before sending any welcome/win-back email. Authorize on the
  // `apikey` header like auto-admin/sync-weather; keep the x-cron-secret fallback.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const requestSecret = req.headers.get('x-cron-secret');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const isServiceRole = serviceRoleKey !== '' && (req.headers.get('apikey') ?? '') === serviceRoleKey;
  if (!isServiceRole && (!cronSecret || requestSecret !== cronSecret)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = getSupabase();
    const results: Record<string, unknown> = {};

    // Job A: Welcome emails
    const welcomeCount = await processWelcomeEmails(supabase);
    results.welcome_sent = welcomeCount;
    console.log(`[behavioral-emails] Welcome emails sent: ${welcomeCount}`);

    // Job B: Win-back emails
    const winBackCount = await processWinBackEmails(supabase);
    results.win_back_sent = winBackCount;
    console.log(`[behavioral-emails] Win-back emails sent: ${winBackCount}`);

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[behavioral-emails] Fatal error:', err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
