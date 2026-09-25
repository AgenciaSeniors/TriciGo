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
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

type OwnerAccount = Pick<CorporateAccount, 'id' | 'name' | 'status' | 'commission_percent'>;

// Which fleet an owner with several corporate accounts sees (lower first).
const OWNER_STATUS_RANK: Record<CorporateAccountStatus, number> = {
  approved: 0,
  pending: 1,
  suspended: 2,
  rejected: 3,
};

export const fleetService = {
  /**
   * Submit a fleet request from a corporate_account owner: the
   * driver_fleets row + N fleet_members rows. Returns the fleet id so the
   * caller can immediately upload license documents per member.
   *
   * Caller must already own the corporate_account (RLS enforced). The
   * account stays pending with is_fleet_owner = false: since 00418/00434
   * only an admin can set that flag.
   *
   * The fleet is upserted on corporate_account_id (UNIQUE), so a retry on
   * the same account after the drivers failed to save reuses the fleet the
   * first attempt created instead of failing on the unique key.
   */
  async submitFleetRequest(params: {
    corporate_account_id: string;
    name: string;
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

    const { data: fleet, error: fleetErr } = await supabase
      .from('driver_fleets')
      .upsert(
        {
          corporate_account_id: params.corporate_account_id,
          name: params.name,
          vehicle_count_estimate: params.vehicle_count_estimate ?? null,
          vehicle_types: params.vehicle_types ?? [],
          operating_zones: params.operating_zones ?? [],
          estimated_rides_per_day_per_vehicle: params.estimated_rides_per_day_per_vehicle ?? null,
          operating_hours_start: params.operating_hours_start ?? null,
          operating_hours_end: params.operating_hours_end ?? null,
          notes: params.notes ?? null,
        },
        { onConflict: 'corporate_account_id' },
      )
      .select('id')
      .single();

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

      const { error: membersErr } = await supabase
        .from('fleet_members')
        .insert(memberRows);

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
   * request sent from the app never carries it. A user can hold several
   * accounts (a corporate client request, a retried fleet request), so the
   * fleet shown is the approved one, else pending, suspended, rejected; the
   * newest wins within a status and the account id breaks a full tie.
   * Throws when a lookup fails, so a failed read is never taken for "no fleet".
   */
  async getFleetByOwner(userId: string): Promise<FleetWithMembers | null> {
    const supabase = getSupabaseClient();

    const { data: accountRows, error: accountsErr } = await supabase
      .from('corporate_accounts')
      .select('id, name, status, commission_percent')
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
      },
    };
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
   */
  async uploadMemberLicense(params: {
    fleet_member_id: string;
    corporate_account_id: string;
    file: Blob | File;
    file_name: string;
    mime_type: string;
  }): Promise<{ storage_path: string }> {
    const supabase = getSupabaseClient();
    const path = `fleet-docs/${params.corporate_account_id}/${params.fleet_member_id}/${params.file_name}`;

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
    formData.append('upsert', 'true');
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

  /** Admin: approve a single fleet member after reviewing their docs. */
  async approveMember(fleetMemberId: string, adminId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('fleet_members')
      .update({
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: adminId,
      })
      .eq('id', fleetMemberId);
    if (error) throw new Error(`Approve member failed: ${error.message}`);
  },

  /** Admin: reject a single fleet member with a reason for the owner to see. */
  async rejectMember(fleetMemberId: string, adminId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('fleet_members')
      .update({
        status: 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: adminId,
        rejected_reason: reason,
      })
      .eq('id', fleetMemberId);
    if (error) throw new Error(`Reject member failed: ${error.message}`);
  },

  /** Admin: list all fleets pending review (queue for /admin/businesses?fleet=pending). */
  async listPendingFleets(): Promise<FleetWithMembers[]> {
    const supabase = getSupabaseClient();
    const { data: accounts, error } = await supabase
      .from('corporate_accounts')
      .select('id, name, status, commission_percent, is_fleet_owner')
      .eq('is_fleet_owner', true)
      .in('status', ['pending', 'approved']);
    if (error || !accounts) return [];

    const out: FleetWithMembers[] = [];
    for (const account of accounts) {
      const { data: fleet } = await supabase
        .from('driver_fleets')
        .select('*')
        .eq('corporate_account_id', account.id)
        .maybeSingle();
      if (!fleet) continue;
      const { data: members } = await supabase
        .from('fleet_members')
        .select('*')
        .eq('fleet_id', fleet.id);
      out.push({
        fleet: fleet as DriverFleet,
        members: (members ?? []) as FleetMember[],
        account: {
          id: account.id,
          name: account.name,
          status: account.status,
          commission_percent: account.commission_percent,
        },
      });
    }
    return out;
  },

  /**
   * Manually trigger the auto-link RPC for a driver that was already
   * registered before their fleet was approved. The DB has an INSERT
   * trigger that handles new signups; this is the after-the-fact path.
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
