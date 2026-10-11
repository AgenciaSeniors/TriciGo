// ============================================================
// delete-account
//
// BUG-Store-Readiness-Client (B2 + D1 + W2)
//
// Authenticated edge function that performs an immediate, irreversible
// account deletion. The flow:
//   1. Verify the caller's Supabase JWT (Bearer token in Authorization
//      header). The user being deleted is always the authenticated
//      user — we never accept a user_id from the request body.
//   2. Call `prepare_account_deletion(user_id)` (00657). In ONE
//      transaction it refuses while the account has a ride in progress or
//      scheduled, an open report or dispute, a debt or a payment in flight
//      (409 with a Spanish `message`), settles the wallet, and re-points
//      every non-CASCADE foreign key to the anonymous user (UUID
//      00000000-…-099), preserving the financial / audit trail. If any
//      reference cannot be moved, nothing is changed. Before 00657 is
//      applied it falls back to the two old RPCs (_shared/account-deletion).
//   3. Best-effort clean of the user's avatar from the `avatars`
//      storage bucket. Failure here doesn't abort the deletion —
//      the row is already anonymized.
//   4. Call `auth.admin.deleteUser(user_id)`. The CASCADE chain from
//      auth.users handles public.users + all CASCADE-flagged child
//      tables (wallet_accounts, trusted_contacts, notifications,
//      recurring_rides, driver_profiles, etc.). The phone/email is
//      freed for re-registration.
//
// Returns: { success: true, anonymized: <stats jsonb> } on success.
// Returns: { error: <code>, message?: <Spanish text> } with HTTP 4xx/5xx on
// failure. `message` is set only when the person can do something about it.
//
// Why no grace period: per product decision (2026-05), deletion is
// immediate. There is no "30-day undo" — once the function returns
// success, the auth.users row is gone and the phone/email can be
// re-registered.
//
// Why a separate function (not direct from the client app): we need
// the service-role key to call auth.admin.deleteUser and to invoke
// `prepare_account_deletion`. The client app must never hold the
// service-role key.
//
// Idempotency: if the user has already been deleted, step 1's
// `auth.getUser` will return unauthorized and the function returns
// 401. Calling again after step 2 succeeded but auth.admin.deleteUser
// failed is safe: the settlement and the re-pointing are no-ops the
// second time. Known gap: a ride created in the milliseconds between
// step 2 and step 4 keeps a reference to the user, so the auth delete
// fails and the account stays, already settled and anonymized; a retry
// is refused until that ride ends.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getServiceKey } from '../_shared/service-key.ts';
import { prepareAccountDeletion } from '../_shared/account-deletion.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

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
  const serviceRoleKey = getServiceKey();
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return jsonResponse(req, { error: 'misconfigured' }, 500);
  }

  // ─── 1. Auth check: verify JWT belongs to a real user ───
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(req, { error: 'unauthorized' }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse(req, { error: 'unauthorized' }, 401);
  }

  const userId = user.id;

  // Guard: never allow deletion of the system or anonymous users.
  if (
    userId === '00000000-0000-0000-0000-000000000001' ||
    userId === '00000000-0000-0000-0000-000000000099'
  ) {
    return jsonResponse(req, { error: 'forbidden_system_account' }, 403);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ─── 2. Gates + wallet settlement + anonymization, all or nothing ───
    //     MUST run before auth.admin.deleteUser: the settlement moves any
    //     balance to platform_revenue (wallet_accounts.user_id is ON DELETE SET
    //     NULL per 00422) and the re-pointing keeps the FKs from blocking the
    //     auth delete. A refusal carries a Spanish message for the person.
    const prepared = await prepareAccountDeletion(admin, userId);
    if (!prepared.ok) {
      console.error('[delete-account] refused for user', userId, ':', prepared.log);
      return jsonResponse(
        req,
        prepared.message ? { error: prepared.error, message: prepared.message } : { error: prepared.error },
        prepared.status,
      );
    }
    const { settled, anonymized } = prepared;

    // ─── 3. Best-effort: clean storage buckets ───

    // 3a. `avatars` bucket — both client and driver upload avatars under
    //     `{user_id}/<filename>` per 00025_avatar_storage.sql. We try
    //     common extensions; if the user uploaded under a different
    //     name, it's a no-op (the cron purge would catch leftovers).
    try {
      await admin.storage
        .from('avatars')
        .remove([`${userId}/avatar.jpg`, `${userId}/avatar.png`, `${userId}/avatar.webp`]);
    } catch {
      // ignore — file may not exist or bucket may not be configured
    }

    // 3b. `driver-documents` bucket — drivers upload KYC docs (carné de
    //     identidad, licencia de conducir, foto del vehículo, selfie de
    //     verificación) under `{user_id}/<doc_type>/<filename>` per
    //     00117_driver_documents_storage_rls.sql. We list-then-remove
    //     because the exact filenames vary per upload. For non-driver
    //     users this is a no-op (list returns empty).
    //
    // The list API returns paths relative to the bucket root. We
    // recursively gather subfolders (one per document type) so the
    // remove call passes the full set of leaf paths in one batch.
    try {
      const { data: rootEntries } = await admin.storage
        .from('driver-documents')
        .list(userId, { limit: 100 });
      const leafPaths: string[] = [];
      for (const entry of rootEntries ?? []) {
        if (entry.id) {
          // file directly under {userId}/
          leafPaths.push(`${userId}/${entry.name}`);
        } else {
          // subfolder per document type → list it
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
    } catch {
      // ignore — non-driver user or bucket misconfigured
    }

    // ─── 4. Hard-delete auth.users (CASCADE handles the rest) ───
    const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
    if (deleteErr) {
      throw new Error(`auth_delete_failed: ${deleteErr.message}`);
    }

    return jsonResponse(req, { success: true, anonymized, settled }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown_error';
    console.error('[delete-account] failed for user', userId, ':', msg);
    // Don't leak internal error details to the client.
    return jsonResponse(req, { error: 'deletion_failed' }, 500);
  }
});
