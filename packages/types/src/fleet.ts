// ============================================================
// TriciGo — Driver Fleet Types
// Tables: driver_fleets + fleet_members (migration 00235).
// A fleet is the operational extension of a corporate_account:
// the account's driver_fleets row. Only an admin can set
// is_fleet_owner (00418/00434), so the app finds a fleet by that
// row, not by the flag.
// ============================================================

export type FleetMemberStatus =
  | 'pending_review'   // owner submitted, admin hasn't acted
  | 'approved'         // admin approved this driver
  | 'rejected'         // admin rejected
  | 'pending_signup'   // approved but driver hasn't registered yet
  | 'active'           // driver registered + linked to fleet
  | 'inactive';        // owner removed the driver

export interface DriverFleet {
  id: string;
  corporate_account_id: string;
  name: string;
  vehicle_count_estimate: number | null;
  vehicle_types: string[];
  operating_zones: string[];
  estimated_rides_per_day_per_vehicle: number | null;
  operating_hours_start: string | null;
  operating_hours_end: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FleetMember {
  id: string;
  fleet_id: string;
  driver_id: string | null;
  driver_name: string;
  driver_phone: string;
  driver_email: string | null;
  driver_license_number: string | null;
  driver_id_number: string | null;
  status: FleetMemberStatus;
  license_doc_path: string | null;
  added_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejected_reason: string | null;
  signed_up_at: string | null;
}

/**
 * The fleet_members columns an admin reviews before deciding on an
 * invitation. The owner may still edit them while the invitation is
 * pending_review, so fleetService.approveMember and rejectMember only act on
 * a row that still holds every value the admin was shown. Once the invitation
 * is reviewed, tg_fleet_members_protect freezes the same columns for the owner
 * (migration 00600); keep both lists equal.
 */
export const FLEET_MEMBER_REVIEWED_FIELDS = [
  'fleet_id',
  'driver_name',
  'driver_phone',
  'driver_email',
  'driver_license_number',
  'driver_id_number',
  'license_doc_path',
] as const satisfies readonly (keyof FleetMember)[];

export type FleetMemberReviewedField = (typeof FLEET_MEMBER_REVIEWED_FIELDS)[number];

/** A fleet invitation as the admin saw it: its id and every reviewed column. */
export type ReviewedFleetMember = Pick<FleetMember, 'id' | FleetMemberReviewedField>;

/**
 * Owner-supplied data for a single fleet member when submitting a
 * fleet request (Phase 4 form). License document is uploaded
 * separately, after the row is created (so we can store the storage
 * path on the row).
 */
export interface FleetMemberInput {
  driver_name: string;
  driver_phone: string;
  driver_email?: string;
  driver_license_number?: string;
  driver_id_number?: string;
}

/**
 * Composite returned by fleet.service.getFleetByOwner — used by the
 * driver app to show the fleet dashboard ("X of Y drivers registered").
 */
export interface FleetWithMembers {
  fleet: DriverFleet;
  members: FleetMember[];
  /** Snapshot from the parent corporate_account for display. */
  account: {
    id: string;
    name: string;
    status: 'pending' | 'approved' | 'suspended' | 'rejected';
    commission_percent: number | null;
    /** Why an admin rejected or suspended the account, as they wrote it. */
    suspended_reason: string | null;
  };
}
