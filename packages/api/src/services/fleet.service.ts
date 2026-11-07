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
  FleetDetailsPatch,
  FleetInviteSend,
  FleetMember,
  FleetMemberInput,
  FleetMemberStatus,
  FleetMembership,
  FleetWithMembers,
  ReviewedFleetMember,
} from '@tricigo/types';
import { normalizeCubanPhone } from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { AppError, AuthError } from '../errors';
import { uploadFileFromUri } from './_storage-upload';
import { onboardingService } from './onboarding.service';

type OwnerAccount = Pick<CorporateAccount, 'id' | 'name' | 'status' | 'commission_percent' | 'suspended_reason'>;

// An invitation in one of these no longer holds a place in the fleet, so the
// owner can invite that number again.
const REINVITABLE_STATUSES: FleetMemberStatus[] = ['rejected', 'inactive'];

// A rejected or suspended company keeps its pending drivers, but they are no
// work for the team: the same two statuses the owner can add drivers in.
const REVIEWABLE_ACCOUNT_STATUSES: CorporateAccountStatus[] = ['pending', 'approved'];

function fleetMemberExists(): AppError {
  return new AppError('Ese teléfono ya está en tu flota.', 'FLEET_MEMBER_EXISTS');
}

/** The driver_fleets columns updateFleet writes. Never id or corporate_account_id (00609). */
const FLEET_DETAIL_COLUMNS = [
  'name',
  'city',
  'vehicle_count_estimate',
  'vehicle_types',
  'operating_zones',
  'estimated_rides_per_day_per_vehicle',
  'operating_hours_start',
  'operating_hours_end',
  'notes',
] as const satisfies readonly (keyof FleetDetailsPatch)[];

/** What resend_fleet_invite and leave_fleet answer: { success: true } or { error, ... }. */
type FleetRpcAnswer = { success?: boolean; error?: string; retry_at?: string } | null;

/** The relation is not there yet: the migration that creates it is not applied (PostgREST / Postgres). */
function isMissingRelation(err: { code?: string } | null | undefined): boolean {
  return err?.code === 'PGRST205' || err?.code === '42P01';
}

/** The function is not there yet: the migration that creates it is not applied. */
function isMissingFunction(err: { code?: string } | null | undefined): boolean {
  return err?.code === 'PGRST202';
}

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
   * Add one driver to a fleet already sent, as a new invitation to review:
   * tg_fleet_members_protect forces pending_review for the owner whatever
   * this sends.
   *
   * The request form saves the number as typed and the unique key is on that
   * raw value, so the rows are compared by their normalized number and the new
   * one is saved in full. A number that holds a place in the fleet is refused
   * with AppError FLEET_MEMBER_EXISTS. A rejected or inactive invitation is
   * frozen for the owner (00600), so it is deleted and the driver invited
   * again, which sends the new data to review. The two steps are not atomic:
   * if the insert fails the old invitation is gone, and the owner just retries.
   * Throws when the fleet cannot be read, so a failed read is never taken for
   * "not in the fleet".
   */
  async addMember(fleetId: string, member: FleetMemberInput): Promise<{ id: string }> {
    const supabase = getSupabaseClient();
    const phone = normalizeCubanPhone(member.driver_phone);

    const { data: rows, error: readErr } = await supabase
      .from('fleet_members')
      .select('id, driver_phone, status')
      .eq('fleet_id', fleetId);
    if (readErr) throw new Error(`Fleet members lookup failed: ${readErr.message}`);

    const sameNumber = ((rows ?? []) as Pick<FleetMember, 'id' | 'driver_phone' | 'status'>[]).filter(
      (m) => normalizeCubanPhone(m.driver_phone) === phone,
    );
    if (sameNumber.some((m) => !REINVITABLE_STATUSES.includes(m.status))) throw fleetMemberExists();

    if (sameNumber.length > 0) {
      const { error: deleteErr } = await supabase
        .from('fleet_members')
        .delete()
        .in('id', sameNumber.map((m) => m.id))
        .in('status', REINVITABLE_STATUSES);
      if (deleteErr) throw new Error(`Fleet member replacement failed: ${deleteErr.message}`);
    }

    const { data: created, error: insertErr } = await supabase
      .from('fleet_members')
      .insert({
        fleet_id: fleetId,
        driver_name: member.driver_name,
        driver_phone: phone,
        driver_email: member.driver_email ?? null,
        driver_license_number: member.driver_license_number ?? null,
        driver_id_number: member.driver_id_number ?? null,
        status: 'pending_review' as const,
      })
      .select('id')
      .single();
    if (insertErr?.code === '23505') throw fleetMemberExists();
    if (insertErr || !created) throw new Error(`Fleet member insertion failed: ${insertErr?.message ?? 'unknown'}`);
    return { id: (created as { id: string }).id };
  },

  /**
   * Take an invitation off the fleet. RLS answers OK with 0 rows to a caller
   * who cannot delete it (or when it is already gone), so the delete asks for
   * the removed rows and 0 is an error, never a silent success.
   */
  async removeMember(memberId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('fleet_members').delete().eq('id', memberId).select('id');
    if (error) throw new Error(`Fleet member removal failed: ${error.message}`);
    if (!data || data.length === 0) {
      throw new AppError('No se pudo quitar al conductor. Actualiza la lista e inténtalo de nuevo.', 'FLEET_MEMBER_NOT_REMOVED');
    }
  },

  /**
   * Invite a rejected or inactive driver again, with the data the row already
   * has. addMember replaces the old row and sends the new one to review.
   */
  async reinviteMember(member: FleetMember): Promise<{ id: string }> {
    return fleetService.addMember(member.fleet_id, {
      driver_name: member.driver_name,
      driver_phone: member.driver_phone,
      driver_email: member.driver_email ?? undefined,
      driver_license_number: member.driver_license_number ?? undefined,
      driver_id_number: member.driver_id_number ?? undefined,
    });
  },

  /**
   * Edit the details of the fleet. Writes driver_fleets and, when the patch
   * carries a name that differs from the fleet's current one, the name of its
   * corporate account too: tg_corporate_accounts_protect_admin_fields does not
   * revert `name`, and the company shows under it in the panel. Both writes ask
   * for the touched rows: RLS answers OK with 0 rows, and 0 is an error
   * (AppError FLEET_NOT_UPDATED), never a silent success. The id and the
   * account of the fleet are never written (00609 freezes them).
   */
  async updateFleet(
    fleet: Pick<DriverFleet, 'id' | 'corporate_account_id'>,
    patch: FleetDetailsPatch,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const notUpdated = () =>
      new AppError('No se pudieron guardar los cambios de la flota. Actualiza e inténtalo de nuevo.', 'FLEET_NOT_UPDATED');

    const values: Record<string, unknown> = {};
    for (const column of FLEET_DETAIL_COLUMNS) {
      if (patch[column] !== undefined) values[column] = patch[column];
    }
    if (Object.keys(values).length === 0) return;

    // The id is the primary key, so maybeSingle() can only see 0 or 1 rows.
    const { data: current, error: readErr } = await supabase
      .from('driver_fleets')
      .select('name')
      .eq('id', fleet.id)
      .maybeSingle();
    if (readErr) throw new Error(`Fleet lookup failed: ${readErr.message}`);
    if (!current) throw notUpdated();

    const { data: updated, error: updateErr } = await supabase
      .from('driver_fleets')
      .update(values)
      .eq('id', fleet.id)
      .select('id');
    if (updateErr) throw new Error(`Fleet update failed: ${updateErr.message}`);
    if (!updated || updated.length === 0) throw notUpdated();

    if (patch.name !== undefined && patch.name !== (current as { name: string }).name) {
      const { data: renamed, error: renameErr } = await supabase
        .from('corporate_accounts')
        .update({ name: patch.name })
        .eq('id', fleet.corporate_account_id)
        .select('id');
      if (renameErr) throw new Error(`Company rename failed: ${renameErr.message}`);
      if (!renamed || renamed.length === 0) throw notUpdated();
    }
  },

  /**
   * The sends of the fleet (00676), newest first. Returns [] while the table
   * does not exist, because the migration is not applied yet. Any other error
   * throws, so a failed read is never taken for "nothing was sent".
   */
  async getInviteSends(fleetId: string): Promise<FleetInviteSend[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('fleet_invite_sends')
      .select('*')
      .eq('fleet_id', fleetId)
      .order('sent_at', { ascending: false });
    if (isMissingRelation(error)) return [];
    if (error) throw new Error(`Invite sends lookup failed: ${error.message}`);
    return (data ?? []) as FleetInviteSend[];
  },

  /**
   * The owner sends the invitation SMS again (resend_fleet_invite, 00676). The
   * function answers a { error } body, not a PostgREST error, so the body is
   * read: too_soon becomes AppError FLEET_INVITE_TOO_SOON (details.retry_at),
   * limit_reached FLEET_INVITE_LIMIT, and anything else, or a failed call,
   * FLEET_INVITE_FAILED (details.reason). The screens show their own text by code.
   */
  async resendInvite(memberId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('resend_fleet_invite', { p_member_id: memberId });
    if (error) {
      throw new AppError('No se pudo reenviar la invitación. Inténtalo de nuevo.', 'FLEET_INVITE_FAILED', 400, {
        reason: error.message,
      });
    }
    const answer = data as FleetRpcAnswer;
    if (answer?.error === 'too_soon') {
      throw new AppError('Ya enviamos la invitación hace poco. Espera un poco antes de reenviarla.', 'FLEET_INVITE_TOO_SOON', 400, {
        retry_at: answer.retry_at,
      });
    }
    if (answer?.error === 'limit_reached') {
      throw new AppError('Llegaste al límite de reenvíos. Inténtalo más tarde.', 'FLEET_INVITE_LIMIT');
    }
    if (answer?.error) {
      throw new AppError('No se pudo reenviar la invitación. Inténtalo de nuevo.', 'FLEET_INVITE_FAILED', 400, {
        reason: answer.error,
      });
    }
  },

  /**
   * The fleets the signed-in driver is in. Reads get_my_fleet_memberships
   * (00676), which also brings the fleet and owner names. While it is not
   * applied (PGRST202) it falls back to getMembershipsForDriver for the session
   * user, with fleet_name and owner_label null. Any other error throws.
   */
  async getMyMemberships(): Promise<FleetMembership[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_my_fleet_memberships');
    if (error && !isMissingFunction(error)) throw new Error(`Fleet memberships lookup failed: ${error.message}`);
    if (!error) return (data ?? []) as FleetMembership[];

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user.id;
    if (!userId) throw new AuthError();
    const rows = await fleetService.getMembershipsForDriver(userId);
    return rows.map((m) => ({
      member_id: m.id,
      fleet_id: m.fleet_id,
      fleet_name: null,
      owner_label: null,
      status: m.status,
      driver_name: m.driver_name,
      driver_phone: m.driver_phone,
      signed_up_at: m.signed_up_at,
    }));
  },

  /**
   * The driver leaves a fleet (leave_fleet, 00676). Like resendInvite, the
   * function answers an { error } body: it becomes AppError FLEET_LEAVE_FAILED
   * with details.reason.
   */
  async leaveFleet(memberId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('leave_fleet', { p_member_id: memberId });
    const reason = error ? error.message : (data as FleetRpcAnswer)?.error;
    if (reason) {
      throw new AppError('No se pudo salir de la flota. Inténtalo de nuevo.', 'FLEET_LEAVE_FAILED', 400, { reason });
    }
  },

  /** A 5-minute signed URL for a license under fleet-docs/ in the driver-documents bucket. */
  async getMemberLicenseUrl(path: string): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from('driver-documents').createSignedUrl(path, 300);
    if (error || !data) throw new Error(`License URL failed: ${error?.message ?? 'unknown'}`);
    return data.signedUrl;
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
   * How many drivers wait for review in each of the accounts, for the admin
   * list. Nothing else tells the team about a driver added to a company it
   * already approved. A company with none, or one that is rejected or
   * suspended, is left out. Throws when a read fails, so a failed read is
   * never taken for "nothing to review".
   */
  async getPendingMemberCounts(
    accounts: Pick<CorporateAccount, 'id' | 'status'>[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const accountIds = accounts.filter((a) => REVIEWABLE_ACCOUNT_STATUSES.includes(a.status)).map((a) => a.id);
    if (accountIds.length === 0) return counts;
    const supabase = getSupabaseClient();

    const { data: fleets, error: fleetsErr } = await supabase
      .from('driver_fleets')
      .select('id, corporate_account_id')
      .in('corporate_account_id', accountIds);
    if (fleetsErr) throw new Error(`Fleet lookup failed: ${fleetsErr.message}`);
    const accountByFleet = new Map(
      ((fleets ?? []) as Pick<DriverFleet, 'id' | 'corporate_account_id'>[]).map((f) => [f.id, f.corporate_account_id]),
    );
    if (accountByFleet.size === 0) return counts;

    const { data: pending, error: pendingErr } = await supabase
      .from('fleet_members')
      .select('fleet_id')
      .in('fleet_id', [...accountByFleet.keys()])
      .eq('status', 'pending_review');
    if (pendingErr) throw new Error(`Fleet members lookup failed: ${pendingErr.message}`);

    for (const { fleet_id } of (pending ?? []) as Pick<FleetMember, 'fleet_id'>[]) {
      const accountId = accountByFleet.get(fleet_id);
      if (accountId) counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    }
    return counts;
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
   * uploadMemberLicense for a file picked on the phone (a file:// or content://
   * URI), through the same storage-upload Edge Function and the same path rules:
   * a name of its own per upload and upsert false, because the EF never replaces
   * a file under fleet-docs/.
   *
   * uploadFileFromUri retries once after a timeout. With upsert false, a retry
   * whose first attempt did land comes back as Storage's 409
   * (upload_failed: The resource already exists), and that one case is a
   * success: the file is there. member_reviewed (also a 409) is not: the owner
   * can no longer add a license, and it becomes AppError FLEET_MEMBER_REVIEWED.
   * Saving license_doc_path asks for the touched row, and 0 rows is an error.
   */
  async uploadMemberLicenseFromUri(params: {
    fleet_member_id: string;
    corporate_account_id: string;
    uri: string;
    file_name: string;
    mime_type: string;
  }): Promise<{ storage_path: string }> {
    const supabase = getSupabaseClient();
    const path = `fleet-docs/${params.corporate_account_id}/${params.fleet_member_id}/${Date.now()}-${params.file_name}`;

    try {
      await uploadFileFromUri('driver-documents', path, params.uri, {
        fileName: params.file_name,
        mimeType: params.mime_type,
        upsert: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'member_reviewed') {
        throw new AppError(
          'Esta invitación ya fue revisada y no se puede cambiar la licencia. Quita al conductor y vuelve a invitarlo.',
          'FLEET_MEMBER_REVIEWED',
          409,
        );
      }
      if (!/^upload_failed\b.*already exists/i.test(message)) throw err;
    }

    const { data, error } = await supabase
      .from('fleet_members')
      .update({ license_doc_path: path })
      .eq('id', params.fleet_member_id)
      .select('id');
    if (error) throw new Error(`Updating license_doc_path failed: ${error.message}`);
    if (!data || data.length === 0) {
      throw new AppError('No se pudo guardar la licencia. Inténtalo de nuevo.', 'FLEET_LICENSE_NOT_SAVED');
    }

    return { storage_path: path };
  },

  /**
   * Approve a fleet invitation as the reviewer saw it, through ops_review_fleet_member (00672),
   * which admins and operators share. Approves nothing and throws AppError FLEET_MEMBER_CHANGED
   * when the invitation changed, was reviewed or was removed since it was loaded. If an active
   * account has already confirmed the phone shown by OTP, the database links it in this same
   * update and the row ends up 'active' (00598).
   */
  async approveMember(shown: ReviewedFleetMember): Promise<void> {
    await onboardingService.reviewFleetMember(shown, 'approved');
  },

  /**
   * Reject a fleet invitation as the reviewer saw it, with a reason for the owner. Throws AppError
   * FLEET_MEMBER_CHANGED like approveMember.
   */
  async rejectMember(shown: ReviewedFleetMember, reason: string): Promise<void> {
    await onboardingService.reviewFleetMember(shown, 'rejected', reason);
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
