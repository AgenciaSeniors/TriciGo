// ============================================================
// TriciGo — Driver Fleet Service
// Wraps driver_fleets + fleet_members tables (migration 00235).
// Workflow: a driver registers a fleet via this service, admin
// reviews via the admin UI, drivers auto-link by phone on signup.
// ============================================================

import type {
  DriverFleet,
  FleetMember,
  FleetMemberInput,
  FleetWithMembers,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const fleetService = {
  /**
   * Submit a new fleet request from a corporate_account owner.
   * Creates the driver_fleets row + N fleet_members rows in one
   * call. Returns the fleet id so the caller can immediately upload
   * license documents per member.
   *
   * Caller must already own the corporate_account (RLS enforced).
   * The corporate_account itself should already exist with
   * is_fleet_owner = true and status = 'pending'.
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
      .insert({
        corporate_account_id: params.corporate_account_id,
        name: params.name,
        vehicle_count_estimate: params.vehicle_count_estimate ?? null,
        vehicle_types: params.vehicle_types ?? [],
        operating_zones: params.operating_zones ?? [],
        estimated_rides_per_day_per_vehicle: params.estimated_rides_per_day_per_vehicle ?? null,
        operating_hours_start: params.operating_hours_start ?? null,
        operating_hours_end: params.operating_hours_end ?? null,
        notes: params.notes ?? null,
      })
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
   * Owner-side query: returns the fleet (with members) belonging to
   * the corporate_account currently owned by the user. NULL if the
   * user has no fleet.
   */
  async getFleetByOwner(userId: string): Promise<FleetWithMembers | null> {
    const supabase = getSupabaseClient();

    const { data: account, error: accountErr } = await supabase
      .from('corporate_accounts')
      .select('id, name, status, commission_percent, is_fleet_owner')
      .eq('created_by', userId)
      .eq('is_fleet_owner', true)
      .maybeSingle();

    if (accountErr || !account) return null;

    const { data: fleet, error: fleetErr } = await supabase
      .from('driver_fleets')
      .select('*')
      .eq('corporate_account_id', account.id)
      .maybeSingle();

    if (fleetErr || !fleet) return null;

    const { data: members } = await supabase
      .from('fleet_members')
      .select('*')
      .eq('fleet_id', fleet.id)
      .order('added_at', { ascending: true });

    return {
      fleet: fleet as DriverFleet,
      members: (members ?? []) as FleetMember[],
      account: {
        id: account.id,
        name: account.name,
        status: account.status,
        commission_percent: account.commission_percent,
      },
    };
  },

  /**
   * Driver-side query: when a driver opens the app, we check if their
   * own user_id is associated with any fleet_members row. If yes, they
   * are part of a fleet and the discounted commission applies.
   */
  async getMembershipForDriver(driverId: string): Promise<FleetMember | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fleet_members')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', ['active', 'approved'])
      .maybeSingle();
    if (error) return null;
    return data as FleetMember | null;
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
