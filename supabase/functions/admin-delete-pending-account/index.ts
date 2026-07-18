// ============================================================
// admin-delete-pending-account
//
// ADMIN-initiated deletion of ANOTHER user's *pending / empty* account,
// so a person stuck mid-registration (e.g. a driver whose onboarding never
// finished, or a phone that already has a stub row) can register again from
// scratch. The admin panel exposes only block/unblock today, which does NOT
// free the phone for re-registration — this closes that gap.
//
// This is a sibling of `delete-account` (the user's OWN self-service delete):
//   • delete-account  → target is ALWAYS the authenticated caller; never a body id.
//   • this function    → target comes from the body, and the caller must be a
//     platform admin/super_admin. To make that safe, deletion is gated behind a
//     strict "is this account really disposable?" check and REFUSED otherwise.
//
// Auth: verify_jwt = false at the gateway (like delete-account / storage-upload)
// — we do our OWN Bearer-token auth inside via auth.getUser, then require the
// caller's users.role ∈ {admin, super_admin}.
//
// Request (POST JSON):
//   { user_id: string, confirm?: boolean, reason?: string }
//   • confirm !== true → DRY RUN: returns { deletable, blockers, summary },
//     mutates nothing. Used by the UI to decide whether to show the button and
//     to explain WHY an account can't be deleted.
//   • confirm === true → performs the deletion iff there are no blockers.
//
// Safety gate — deletion is REFUSED if the target account has anything worth
// keeping. Blockers (any one refuses):
//   • system_account : the system / anonymous users (never deletable)
//   • self           : an admin cannot delete their own account here (use the
//                      normal self-delete flow — avoids losing the acting admin)
//   • is_staff       : role ∈ {admin, super_admin}
//   • has_balance    : any wallet_account with balance ≠ 0 or held_balance ≠ 0
//   • has_rides      : any ride (as customer OR as driver) not 'canceled'
// A pending driver profile, canceled-only rides, and an incomplete profile are
// all disposable and do NOT block.
//
// On confirm, the actual delete reuses the same idempotent machinery as
// delete-account: settle_and_scrub_for_deletion → anonymize_user_references →
// best-effort storage cleanup → auth.admin.deleteUser (CASCADE frees the phone).
// Every deletion writes an admin_actions audit row (old_values = snapshot).
//
// Returns: { deletable, blockers, summary } (dry run) or
//          { success: true, summary } (confirmed) or { error, ... } with 4xx/5xx.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

const SYSTEM_USER_IDS = new Set([
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000099',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method_not_allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return jsonResponse(req, { error: 'misconfigured' }, 500);
  }

  // ─── 1. Auth: verify the Bearer token belongs to a real user ───
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(req, { error: 'unauthorized' }, 401);
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
  if (callerError || !caller) {
    return jsonResponse(req, { error: 'unauthorized' }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ─── 2. Authorize: caller must be a platform admin ───
  const { data: callerRow, error: callerRowErr } = await admin
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .maybeSingle();
  if (callerRowErr) {
    console.error('[admin-delete-pending-account] caller role lookup failed:', callerRowErr.message);
    return jsonResponse(req, { error: 'db_error' }, 503);
  }
  if (!callerRow || !['admin', 'super_admin'].includes(callerRow.role as string)) {
    return jsonResponse(req, { error: 'forbidden' }, 403);
  }

  // ─── 3. Parse body ───
  let body: { user_id?: unknown; confirm?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: 'invalid_body' }, 400);
  }
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const confirm = body.confirm === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!UUID_RE.test(userId)) {
    return jsonResponse(req, { error: 'invalid_user_id' }, 400);
  }

  try {
    // ─── 4. Load the target + evaluate blockers ───
    const { data: target, error: targetErr } = await admin
      .from('users')
      .select('id, full_name, phone, email, role, is_active, total_rides, created_at')
      .eq('id', userId)
      .maybeSingle();
    if (targetErr) throw new Error(`target_lookup_failed: ${targetErr.message}`);
    if (!target) {
      return jsonResponse(req, { error: 'not_found' }, 404);
    }

    // Driver profile (for driver-side ride lookups + status display).
    const { data: driverProfile, error: dpErr } = await admin
      .from('driver_profiles')
      .select('id, status')
      .eq('user_id', userId)
      .maybeSingle();
    if (dpErr) throw new Error(`driver_profile_lookup_failed: ${dpErr.message}`);

    // Wallets — a pending account has none; ANY non-zero balance blocks.
    const { data: wallets, error: walletErr } = await admin
      .from('wallet_accounts')
      .select('account_type, balance, held_balance')
      .eq('user_id', userId);
    if (walletErr) throw new Error(`wallet_lookup_failed: ${walletErr.message}`);
    const walletBalanceTotal = (wallets ?? []).reduce(
      (s, w) => s + Number(w.balance ?? 0), 0);
    const walletHeldTotal = (wallets ?? []).reduce(
      (s, w) => s + Number(w.held_balance ?? 0), 0);

    // Rides as customer (any status other than 'canceled' counts as history).
    // NOTE: the ride_status enum uses the single-L US spelling 'canceled';
    // 'cancelled' is NOT a valid label and makes PostgREST throw 22P02.
    const { count: ridesAsCustomer, error: rcErr } = await admin
      .from('rides')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', userId)
      .neq('status', 'canceled');
    if (rcErr) throw new Error(`customer_rides_lookup_failed: ${rcErr.message}`);

    // Rides as driver (needs the driver_profiles.id).
    let ridesAsDriver = 0;
    if (driverProfile?.id) {
      const { count, error: rdErr } = await admin
        .from('rides')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driverProfile.id)
        .neq('status', 'canceled');
      if (rdErr) throw new Error(`driver_rides_lookup_failed: ${rdErr.message}`);
      ridesAsDriver = count ?? 0;
    }

    const blockers: string[] = [];
    if (SYSTEM_USER_IDS.has(userId)) blockers.push('system_account');
    if (userId === caller.id) blockers.push('self');
    if (['admin', 'super_admin'].includes(target.role as string)) blockers.push('is_staff');
    if (walletBalanceTotal !== 0 || walletHeldTotal !== 0) blockers.push('has_balance');
    if ((ridesAsCustomer ?? 0) > 0 || ridesAsDriver > 0) blockers.push('has_rides');

    const summary = {
      user_id: userId,
      full_name: target.full_name ?? '',
      phone: target.phone ?? null,
      email: target.email ?? null,
      role: target.role,
      driver_status: driverProfile?.status ?? null,
      wallet_balance_total: walletBalanceTotal,
      wallet_held_total: walletHeldTotal,
      rides_as_customer: ridesAsCustomer ?? 0,
      rides_as_driver: ridesAsDriver,
      created_at: target.created_at ?? null,
    };

    // ─── 5. Dry run — report deletability, mutate nothing ───
    if (!confirm) {
      return jsonResponse(req, { deletable: blockers.length === 0, blockers, summary }, 200);
    }

    // ─── 6. Confirmed delete — refuse if any blocker ───
    if (blockers.length > 0) {
      return jsonResponse(req, { error: 'not_deletable', blockers, summary }, 409);
    }

    // 6a. Settle any (zero, by the gate above) balance + scrub authored free text.
    //     Kept for parity with delete-account and as defense-in-depth.
    const { error: settleErr } = await admin.rpc('settle_and_scrub_for_deletion', {
      p_user_id: userId,
    });
    if (settleErr) throw new Error(`settle_failed: ${settleErr.message}`);

    // 6b. Re-point non-CASCADE FKs to the anonymous user so the auth delete
    //     cascade doesn't trip a constraint (idempotent).
    const { error: anonErr } = await admin.rpc('anonymize_user_references', {
      p_user_id: userId,
    });
    if (anonErr) throw new Error(`anonymize_failed: ${anonErr.message}`);

    // 6c. Best-effort storage cleanup (avatars + driver KYC docs).
    try {
      await admin.storage
        .from('avatars')
        .remove([`${userId}/avatar.jpg`, `${userId}/avatar.png`, `${userId}/avatar.webp`]);
    } catch { /* no-op */ }
    try {
      const { data: rootEntries } = await admin.storage
        .from('driver-documents')
        .list(userId, { limit: 100 });
      const leafPaths: string[] = [];
      for (const entry of rootEntries ?? []) {
        if (entry.id) {
          leafPaths.push(`${userId}/${entry.name}`);
        } else {
          const { data: subEntries } = await admin.storage
            .from('driver-documents')
            .list(`${userId}/${entry.name}`, { limit: 100 });
          for (const sub of subEntries ?? []) {
            leafPaths.push(`${userId}/${entry.name}/${sub.name}`);
          }
        }
      }
      if (leafPaths.length > 0) {
        await admin.storage.from('driver-documents').remove(leafPaths);
      }
    } catch { /* no-op */ }

    // 6d. Hard-delete auth.users (CASCADE handles public.users + child tables,
    //     frees the phone/email for re-registration).
    const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
    if (deleteErr) throw new Error(`auth_delete_failed: ${deleteErr.message}`);

    // 6e. Audit trail. Best-effort — the account is already gone.
    try {
      await admin.from('admin_actions').insert({
        admin_id: caller.id,
        action: 'delete_pending_account',
        target_type: 'user',
        target_id: userId,
        old_values: summary,
        reason: reason || null,
      });
    } catch (e) {
      console.error('[admin-delete-pending-account] audit insert failed:', e);
    }

    return jsonResponse(req, { success: true, summary }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown_error';
    console.error('[admin-delete-pending-account] failed for user', userId, ':', msg);
    return jsonResponse(req, { error: 'deletion_failed' }, 500);
  }
});
