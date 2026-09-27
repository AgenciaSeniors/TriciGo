// ============================================================
// TriciGo — Driver Fleet Service
// Wraps driver_fleets + fleet_members tables (migration 00235).
// Workflow: a driver registers a fleet via this service, admin
// reviews via the admin UI, drivers auto-link by phone on signup.
// ============================================================

import type {
  CorporateAccount,
  CorporateAccountStatus,
  DriverFleet,
  FleetMember,
  FleetMemberInput,
  FleetWithMembers,
  ReviewedFleetMember,
} from '@tricigo/types';
import { FLEET_MEMBER_REVIEWED_FIELDS } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { AppError, AuthError } from '../errors';

type OwnerAccount = Pick<CorporateAccount, 'id' | 'name' | 'status' | 'commission_percent' | 'suspended_reason'>;

/** PostgREST's "column does not exist" for exactly driver_fleets.city (00602). */
function isMissingCityColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err || err.code !== 'PGRST204') return false;
  return /\bcity\b/.test(err.message ?? '');
}

// Which fleet an owner with several corporate accounts sees (lower first).
const OWNER_STATUS_RANK: Record<CorporateAccountStatus, number> = {
  approved: 0,
  pending: 1,
  suspended: 2,
  rejected: 3,
};

/**
 * Whether the client holds a session. Without one supabase-js sends the
 * publishable key as the bearer, RLS hides every fleet_members row and an
 * update matches nothing, which would read as a changed invitation. The admin
 * panel copies its cookie session into this client on a best-effort basis
 * (useAdminUser), so the case is real. Same rule as driver.service: when the
 * SDK cannot even answer, let the request go and surface the real error.
 */
async function hasSession(supabase: ReturnType<typeof getSupabaseClient>): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data?.session);
  } catch {
    return true;
  }
}

/**
 * Records an admin decision on a fleet invitation only while the row is still
 * what the admin reviewed: pending_review, with every reviewed column equal to
 * the value shown. The owner may edit a pending invitation, so matching on the
 * id alone would record the decision against data the admin never saw. A NULL
 * is matched with is(), because eq(column, null) compares against the text
 * "null". When the update waits on the row lock, READ COMMITTED re-checks this
 * WHERE on the version the owner committed, so a concurrent edit also leaves it
 * matching nothing (supabase/tests/fleet-review/run.sh). Throws AuthError
 * without a session, and AppError FLEET_MEMBER_CHANGED when nothing matched:
 * the invitation changed, was reviewed or was removed since it was loaded (or
 * the caller is no longer an admin, since RLS hides the row from anyone else).
 */
async function reviewShownMember(
  shown: ReviewedFleetMember,
  decision: { status: 'approved' | 'rejected'; reviewed_by: string; rejected_reason?: string },
  failure: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!(await hasSession(supabase))) throw new AuthError(`${failure}: no auth session`);

  let update = supabase
    .from('fleet_members')
    .update({ ...decision, reviewed_at: new Date().toISOString() })
    .eq('id', shown.id)
    .eq('status', 'pending_review');
  for (const field of FLEET_MEMBER_REVIEWED_FIELDS) {
    const value = shown[field];
    update = value === null ? update.is(field, null) : update.eq(field, value);
  }

  const { data, error } = await update.select('id');
  if (error) throw new Error(`${failure}: ${error.message}`);
  if (!data || data.length === 0) {
    throw new AppError(`${failure}: fleet member ${shown.id} changed since it was loaded`, 'FLEET_MEMBER_CHANGED', 409);
  }
}

export const fleetService = {
  /**
   * Submit a fleet request from a corporate_account owner: the
   * driver_fleets row + N fleet_members rows. Returns the fleet id so the
   * caller can immediately upload license documents per member.
   *
   * Caller must already own the corporate_account (RLS enforced). The
   * account stays pending with is_fleet_owner = false: since 00418/00434
   * only an admin can set that flag, and corporateService.approveAccount
   * sets it when it approves the fleet.
   *
   * Both writes are safe to retry on the same account. The fleet is upserted
   * on corporate_account_id (UNIQUE), so a retry reuses the fleet a previous
   * attempt created and applies the new values. The drivers are inserted on
   * (fleet_id, driver_phone) ignoring duplicates, so drivers already saved
   * are kept as they are and only the missing ones are added. A phone listed
   * twice is saved once.
   *
   * While 00602 is not applied driver_fleets has no city column, and the
   * fleet is saved without it rather than failing the request.
   */
  async submitFleetRequest(params: {
    corporate_account_id: string;
    name: string;
    /** 00602: main city / municipality. */
    city?: string;
    vehicle_count_estimate?: number;
    vehicle_types?: string[];
    operating_zones?: string[];
    estimated_rides_per_day_per_vehicle?: number;
    operating_hours_start?: string;
    operating_hours_end?: string;
    notes?: string;
    members: FleetMemberInput[];
  }): Promise<{ fleet_id: string }> {
    const supabase = getSupabaseClient();

    const fleetRow: Record<string, unknown> = {
      corporate_account_id: params.corporate_account_id,
      name: params.name,
      city: params.city ?? null,
      vehicle_count_estimate: params.vehicle_count_estimate ?? null,
      vehicle_types: params.vehicle_types ?? [],
      operating_zones: params.operating_zones ?? [],
      estimated_rides_per_day_per_vehicle: params.estimated_rides_per_day_per_vehicle ?? null,
      operating_hours_start: params.operating_hours_start ?? null,
      operating_hours_end: params.operating_hours_end ?? null,
      notes: params.notes ?? null,
    };
    const upsertFleet = (row: Record<string, unknown>) =>
      supabase
        .from('driver_fleets')
        .upsert(row, { onConflict: 'corporate_account_id' })
        .select('id')
        .single();

    let { data: fleet, error: fleetErr } = await upsertFleet(fleetRow);
    if (fleetErr && isMissingCityColumn(fleetErr)) {
      console.warn('[fleetService] driver_fleets.city missing (00602 not applied) — saving the fleet without the city');
      const { city: _city, ...withoutCity } = fleetRow;
      ({ data: fleet, error: fleetErr } = await upsertFleet(withoutCity));
    }

    if (fleetErr || !fleet) {
      throw new Error(`Fleet creation failed: ${fleetErr?.message ?? 'unknown'}`);
    }

    if (params.members.length > 0) {
      const memberRows = params.members.map((m) => ({
        fleet_id: fleet.id,
        driver_name: m.driver_name,
        driver_phone: m.driver_phone,
        driver_email: m.driver_email ?? null,
        driver_license_number: m.driver_license_number ?? null,
        driver_id_number: m.driver_id_number ?? null,
        status: 'pending_review' as const,
      }));

      // A driver already saved on this fleet (same phone) is left as it is.
      const { error: membersErr } = await supabase
        .from('fleet_members')
        .upsert(memberRows, { onConflict: 'fleet_id,driver_phone', ignoreDuplicates: true });

      if (membersErr) {
        throw new Error(`Fleet member insertion failed: ${membersErr.message}`);
      }
    }

    return { fleet_id: fleet.id };
  },

  /**
   * Owner-side query: the fleet (with members) of a corporate account the
   * user created, or NULL when none of their accounts has a fleet.
   *
   * The driver_fleets row is what makes an account a fleet, not
   * is_fleet_owner: since 00418/00434 only an admin can set that flag, so a
   * request sent from the app carries it only once approved. A user can hold
   * several accounts (a corporate client request, a retried fleet request),
   * so the fleet shown is the approved one, else pending, suspended,
   * rejected; the newest wins within a status and the account id breaks a
   * full tie. The account carries the admin's reason when it was rejected
   * or suspended.
   * Throws when a lookup fails, so a failed read is never taken for "no fleet".
   */
  async getFleetByOwner(userId: string): Promise<FleetWithMembers | null> {
    const supabase = getSupabaseClient();

    const { data: accountRows, error: accountsErr } = await supabase
      .from('corporate_accounts')
      .select('id, name, status, commission_percent, suspended_reason')
      .eq('created_by', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true });
    if (accountsErr) throw new Error(`Fleet owner lookup failed: ${accountsErr.message}`);
    const accounts = (accountRows ?? []) as OwnerAccount[];
    if (accounts.length === 0) return null;

    const { data: fleetRows, error: fleetsErr } = await supabase
      .from('driver_fleets')
      .select('*')
      .in('corporate_account_id', accounts.map((a) => a.id));
    if (fleetsErr) throw new Error(`Fleet lookup failed: ${fleetsErr.message}`);
    const fleetByAccount = new Map(
      ((fleetRows ?? []) as DriverFleet[]).map((f) => [f.corporate_account_id, f]),
    );

    // accounts come newest first, so the first one seen at each status is
    // the one to keep; only a better status replaces it.
    let owned: { account: OwnerAccount; fleet: DriverFleet } | null = null;
    for (const account of accounts) {
      const fleet = fleetByAccount.get(account.id);
      if (!fleet) continue;
      if (!owned || OWNER_STATUS_RANK[account.status] < OWNER_STATUS_RANK[owned.account.status]) {
        owned = { account, fleet };
      }
    }
    if (!owned) return null;

    const { data: members, error: membersErr } = await supabase
      .from('fleet_members')
      .select('*')
      .eq('fleet_id', owned.fleet.id)
      .order('added_at', { ascending: true });
    if (membersErr) throw new Error(`Fleet members lookup failed: ${membersErr.message}`);

    return {
      fleet: owned.fleet,
      members: (members ?? []) as FleetMember[],
      account: {
        id: owned.account.id,
        name: owned.account.name,
        status: owned.account.status,
        commission_percent: owned.account.commission_percent,
        suspended_reason: owned.account.suspended_reason,
      },
    };
  },

  /**
   * The ids, among accountIds, of the corporate accounts that have a
   * driver_fleets row. That row is what tells a fleet request sent from the
   * driver app from a corporate client request until an admin approves it:
   * the app cannot set is_fleet_owner (00418/00434). RLS shows a fleet row
   * only to an admin and to the account's creator, the two callers this
   * serves; for anyone else a missing id proves nothing. Throws when the
   * lookup fails, so a failed read is never taken for "not a fleet".
   */
  async getAccountIdsWithFleet(accountIds: string[]): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_fleets')
      .select('corporate_account_id')
      .in('corporate_account_id', accountIds);
    if (error) throw new Error(`Fleet lookup failed: ${error.message}`);
    return new Set(
      ((data ?? []) as Pick<DriverFleet, 'corporate_account_id'>[]).map((f) => f.corporate_account_id),
    );
  },

  /**
   * Driver-side query: the fleets the driver belongs to, one entry per
   * fleet, active ones first. Never assumes a single row: the signup
   * auto-link and the admin relink link every invitation that matches the
   * driver's phone, and one fleet can hold the number twice in two formats
   * (unique on the raw phone, matched on the normalized one). A fleet shows
   * through its active row, else its latest signup. Throws when the lookup
   * fails, so a failed read is never taken for "no fleet".
   */
  async getMembershipsForDriver(driverId: string): Promise<FleetMember[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fleet_members')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', ['active', 'approved'])
      .order('signed_up_at', { ascending: false, nullsFirst: false })
      .order('added_at', { ascending: false })
      .order('id', { ascending: true });
    if (error) throw new Error(`Fleet membership lookup failed: ${error.message}`);

    const rows = (data ?? []) as FleetMember[];
    const activeFirst = [
      ...rows.filter((m) => m.status === 'active'),
      ...rows.filter((m) => m.status !== 'active'),
    ];
    const seenFleets = new Set<string>();
    return activeFirst.filter((m) => {
      if (seenFleets.has(m.fleet_id)) return false;
      seenFleets.add(m.fleet_id);
      return true;
    });
  },

  /**
   * Upload a license document for a fleet_member into the
   * 'driver-documents' bucket under the fleet-docs/ prefix, via the
   * storage-upload Edge Function. The path includes the corporate account
   * so the EF can enforce ownership (creator / active corp admin).
   *
   * For the owner, a licence can only be added while the member is
   * pending_review. Once the admin has reviewed it, the EF refuses the
   * upload (409 member_reviewed) and the database keeps the reviewed
   * license_doc_path (00600). The EF never replaces a file under fleet-docs/,
   * so each upload gets a name of its own (the time, then the original
   * name). To replace a reviewed member's licence, delete the member and
   * invite again.
   */
  async uploadMemberLicense(params: {
    fleet_member_id: string;
    corporate_account_id: string;
    file: Blob | File;
    file_name: string;
    mime_type: string;
  }): Promise<{ storage_path: string }> {
    const supabase = getSupabaseClient();
    const path = `fleet-docs/${params.corporate_account_id}/${params.fleet_member_id}/${Date.now()}-${params.file_name}`;

    // A6-01: the old code uploaded straight to a 'driver-docs' BUCKET that
    // doesn't exist in prod ('driver-docs' is a path PREFIX inside the
    // 'driver-documents' bucket) — and direct authenticated Storage uploads
    // fail RLS anyway since the ES256 signing-key migration. Route through
    // the storage-upload EF (gotrue auth + per-path authz + service-role
    // upload), like every other upload. Callers hold a Blob/File, so we
    // send the multipart form directly (mirror of the web avatar flow).
    const formData = new FormData();
    formData.append('file', params.file, params.file_name);
    formData.append('bucket', 'driver-documents');
    formData.append('path', path);
    formData.append('upsert', 'false');
    formData.append('contentType', params.mime_type);

    const { data, error: uploadErr } = await supabase.functions.invoke('storage-upload', {
      body: formData,
    });
    if (uploadErr) throw new Error(`License upload failed: ${uploadErr.message}`);
    const efError = (data as { error?: string } | null)?.error;
    if (efError) throw new Error(`License upload failed: ${efError}`);

    const { error: updateErr } = await supabase
      .from('fleet_members')
      .update({ license_doc_path: path })
      .eq('id', params.fleet_member_id);

    if (updateErr) throw new Error(`Updating license_doc_path failed: ${updateErr.message}`);

    return { storage_path: path };
  },

  /**
   * Admin: approve a fleet invitation as the admin saw it. Approves nothing
   * and throws AppError FLEET_MEMBER_CHANGED when the invitation changed, was
   * reviewed or was removed since it was loaded. If an active account has
   * already confirmed the phone shown by OTP, the database links it in this
   * same update and the row ends up 'active' (00598).
   */
  async approveMember(shown: ReviewedFleetMember, adminId: string): Promise<void> {
    await reviewShownMember(shown, { status: 'approved', reviewed_by: adminId }, 'Approve member failed');
  },

  /**
   * Admin: reject a fleet invitation as the admin saw it, with a reason for
   * the owner. Throws AppError FLEET_MEMBER_CHANGED like approveMember.
   */
  async rejectMember(shown: ReviewedFleetMember, adminId: string, reason: string): Promise<void> {
    await reviewShownMember(
      shown,
      { status: 'rejected', reviewed_by: adminId, rejected_reason: reason },
      'Reject member failed',
    );
  },

  /**
   * Manual fallback: link the approved invitations for `phone` to the given
   * account. The database already links on its own at signup, at approval
   * and when an account confirms its phone later (00598), always to the one
   * active account whose number is OTP-confirmed. This is for the cases that
   * rule leaves out, such as a number that was never confirmed or an account
   * reactivated after the approval. No screen calls it yet.
   */
  async relinkExistingDriver(driverId: string, phone: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .rpc('relink_fleet_member_for_existing_driver', {
        p_driver_id: driverId,
        p_phone: phone,
      });
    if (error) throw new Error(`Relink failed: ${error.message}`);
    return (data as number) ?? 0;
  },
};
