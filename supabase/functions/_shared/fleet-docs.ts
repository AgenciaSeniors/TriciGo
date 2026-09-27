// ============================================================
// Fleet member documents — who may write them, and never in place.
//
// storage-upload writes these into the private 'driver-documents' bucket at
//   fleet-docs/{corporateAccountId}/{fleetMemberId}/{file}
// with the service-role key, so the rules below are the only thing that
// guards the files. Storage RLS gives nobody a write under fleet-docs/.
//
// WHY THE RULES (found 2026-09-25 while writing 00600): 00600 freezes the
// reviewed identity of a fleet_members row, license_doc_path included, for
// the fleet owner once the invitation leaves 'pending_review'. The file
// behind that path stayed writable: the EF authorized the account's managers
// for a member in any status and obeyed the caller's upsert flag, so
// uploading the same file name replaced the reviewed licence in place and
// the admin saw a document they never reviewed behind an unchanged path.
//  - A manager (the account's creator or an active corp admin) writes only
//    while the member awaits review. A platform admin may write any time.
//  - Nothing under fleet-docs/ is replaced in place, whoever asks: a path
//    names one content forever, so the path the admin reviewed is the file.
//    Uploads use a new name each time (fleet.service.uploadMemberLicense).
//
// Pure module with no remote imports, so packages/api's vitest runs its test
// unmodified. The EF supplies the database lookups.
// ============================================================

export interface FleetDocMember {
  /** corporate_account_id of the member's fleet; null if the fleet is missing. */
  corporateAccountId: string | null;
  /** fleet_members.status */
  status: string;
}

export interface FleetDocLookups {
  /** The member, or null when no row has that id. */
  member(memberId: string): Promise<FleetDocMember | null>;
  /** Whether the caller is a platform admin. */
  isAdmin(): Promise<boolean>;
  /** Whether the caller created the account or is one of its active admins. */
  managesAccount(corporateAccountId: string): Promise<boolean>;
}

/**
 * allowed: upload. forbidden: the caller may not touch this member's
 * documents. member_reviewed: the caller manages the account, but the admin
 * already reviewed the member, so its documents are closed.
 */
export type FleetDocVerdict = 'allowed' | 'forbidden' | 'member_reviewed';

/** The only status in which the account's managers may add documents. */
const AWAITING_REVIEW = 'pending_review';

export const FLEET_DOCS_PREFIX = 'fleet-docs';

/**
 * Decide an upload to fleet-docs/{corporateAccountId}/{memberId}/…. The
 * member has to belong to that account. The status is only looked at once
 * the caller is known to manage the account, so a stranger learns nothing
 * about the member. A failed lookup rejects, and no upload happens.
 */
export async function authorizeFleetDocUpload(
  corporateAccountId: string,
  memberId: string,
  lookups: FleetDocLookups,
): Promise<FleetDocVerdict> {
  if (!corporateAccountId || !memberId) return 'forbidden';
  const member = await lookups.member(memberId);
  if (!member?.corporateAccountId || member.corporateAccountId !== corporateAccountId) return 'forbidden';
  if (await lookups.isAdmin()) return 'allowed';
  if (!(await lookups.managesAccount(corporateAccountId))) return 'forbidden';
  return member.status === AWAITING_REVIEW ? 'allowed' : 'member_reviewed';
}

/**
 * The upsert flag to hand to Storage for this upload. Under fleet-docs/ it is
 * always false, whatever the caller sent: Storage then refuses a name that is
 * already taken, and that file stays as it was. Elsewhere the caller's flag
 * is kept.
 */
export function storageUpsert(bucket: string, segs: string[], requested: boolean): boolean {
  if (bucket === 'driver-documents' && segs[0] === FLEET_DOCS_PREFIX) return false;
  return requested;
}
