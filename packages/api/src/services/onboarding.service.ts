// ============================================================
// TriciGo — driver onboarding and fleet review from the panel (00672)
//
// Every decision goes through an ops_* function that admins and operators share
// (supabase/migrations/00672_operator_driver_onboarding.sql): approve, reject or suspend a
// driver, review a document, record one support uploaded, log a contact, and review a fleet
// request or a driver a fleet invites. The server checks the caller, logs the decision and sends
// the driver's push; refusals come back as AppErrors carrying the server's code.
// ============================================================

import { FLEET_MEMBER_REVIEWED_FIELDS } from '@tricigo/types';
import type { DriverDocument, DriverStatus, ReviewedFleetMember } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { AppError } from '../errors';
import { callOpsRpc, trimmedText } from './_ops-rpc';

/** An ops function the database does not have yet (00672 not applied). */
export const ONBOARDING_UNAVAILABLE = 'ONBOARDING_UNAVAILABLE';

export type DriverDecision = Extract<DriverStatus, 'approved' | 'rejected' | 'suspended'>;
export type ReviewDecision = 'approved' | 'rejected';
export type OutreachChannelCode = 'whatsapp' | 'llamada' | 'sms' | 'otro';

/** What a driver's first approval did with the approval bonus (00686). */
export type ApprovalBonusStatus =
  | 'paid' // credited now
  | 'already_paid' // this account or this confirmed phone got it before
  | 'no_phone' // no confirmed phone: one bonus per person needs one
  | 'disabled' // driver_approval_bonus_cup is 0
  | 'invalid_amount' // the amount in Settings is not a whole number from 1 to 50000
  | 'failed' // the payment failed; the approval stands
  | 'no_driver';

export interface ApprovalBonus {
  status: ApprovalBonusStatus;
  /** CUP credited, when paid. */
  amountCup: number | null;
}

export interface DriverStatusResult {
  /** Null unless the decision was the profile's first approval (and before 00686 is applied). */
  bonus: ApprovalBonus | null;
}

const APPROVAL_BONUS_STATUSES: ReadonlySet<string> = new Set<ApprovalBonusStatus>([
  'paid', 'already_paid', 'no_phone', 'disabled', 'invalid_amount', 'failed', 'no_driver',
]);

/** The server's `bonus`, or null for none or for an outcome this build does not know. */
function parseApprovalBonus(raw: unknown): ApprovalBonus | null {
  if (!raw || typeof raw !== 'object') return null;
  const { status, amount_cup: amount } = raw as Record<string, unknown>;
  if (typeof status !== 'string' || !APPROVAL_BONUS_STATUSES.has(status)) return null;
  return { status: status as ApprovalBonusStatus, amountCup: typeof amount === 'number' ? amount : null };
}

const trimmed = trimmedText;
const callOps = (rpc: string, args: Record<string, unknown>) => callOpsRpc(rpc, args, ONBOARDING_UNAVAILABLE);

export const onboardingService = {
  /**
   * Approve, reject or suspend a driver. `expectedStatus` is the status the reviewer saw: the
   * server refuses with driver_changed if it moved. Reject and suspend need a reason. A profile's
   * first approval also pays the approval bonus (00686): `bonus` says what happened.
   */
  async setDriverStatus(
    driverId: string,
    status: DriverDecision,
    expectedStatus: string,
    reason?: string,
  ): Promise<DriverStatusResult> {
    const result = await callOps('ops_set_driver_status', {
      p_driver_id: driverId,
      p_status: status,
      p_expected_status: expectedStatus,
      p_reason: trimmed(reason),
    });
    return { bonus: parseApprovalBonus(result.bonus) };
  },

  /**
   * Verify or reject one document. `message` is what the driver reads (required to reject);
   * `reasonCodes` and `note` go to the rejection e-mail.
   */
  async reviewDocument(
    documentId: string,
    verified: boolean,
    detail: { message?: string | null; reasonCodes?: string[]; note?: string | null },
  ): Promise<void> {
    await callOps('ops_review_driver_document', {
      p_document_id: documentId,
      p_verified: verified,
      p_message: trimmed(detail.message),
      p_reason_codes: detail.reasonCodes ?? [],
      p_note: trimmed(detail.note),
    });
  },

  /**
   * A document support received out of band (the driver could not upload it). Stored by the
   * storage-upload Edge Function under driver-docs/<driver>/<type>/, then recorded unverified.
   */
  async addDocument(driverId: string, documentType: string, file: File): Promise<DriverDocument> {
    const supabase = getSupabaseClient();
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const fileName = `${documentType}_${Date.now()}.${ext}`;
    const storagePath = `driver-docs/${driverId}/${documentType}/${fileName}`;
    const mimeType = file.type || 'image/jpeg';

    const formData = new FormData();
    formData.append('file', file);
    formData.append('bucket', 'driver-documents');
    formData.append('path', storagePath);
    formData.append('upsert', 'true');
    formData.append('contentType', mimeType);
    const { data, error } = await supabase.functions.invoke('storage-upload', { body: formData });
    if (error) throw error;
    const uploadError = (data as { error?: string } | null)?.error;
    if (uploadError) throw new Error(String(uploadError));

    const result = await callOps('ops_add_driver_document', {
      p_driver_id: driverId,
      p_document_type: documentType,
      p_storage_path: storagePath,
      p_file_name: fileName,
      p_mime_type: mimeType,
    });
    return result.document as DriverDocument;
  },

  /** Records that the team contacted a driver who did not finish signing up. */
  async logOutreach(driverProfileId: string, channel: OutreachChannelCode, note?: string | null): Promise<void> {
    await callOps('ops_log_driver_outreach', {
      p_driver_profile_id: driverProfileId,
      p_channel: channel,
      p_note: trimmed(note),
    });
  },

  /**
   * Approve or reject a fleet request (an account with a driver_fleets row; approving also makes
   * it the fleet owner). Corporate clients without a fleet stay with corporateService.
   */
  async reviewFleetAccount(accountId: string, decision: ReviewDecision, expectedStatus: string, reason?: string): Promise<void> {
    await callOps('ops_review_fleet_account', {
      p_account_id: accountId,
      p_decision: decision,
      p_expected_status: expectedStatus,
      p_reason: trimmed(reason),
    });
  },

  /**
   * Approve or reject a driver a fleet invites, as the reviewer saw the invitation. Throws AppError
   * FLEET_MEMBER_CHANGED when it changed, was reviewed or was removed since it was loaded.
   */
  async reviewFleetMember(shown: ReviewedFleetMember, decision: ReviewDecision, reason?: string): Promise<void> {
    const shownFields: Record<string, unknown> = {};
    for (const field of FLEET_MEMBER_REVIEWED_FIELDS) shownFields[field] = shown[field];
    try {
      await callOps('ops_review_fleet_member', {
        p_member_id: shown.id,
        p_decision: decision,
        p_shown: shownFields,
        p_reason: trimmed(reason),
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'member_changed') {
        throw new AppError(`fleet member ${shown.id} changed since it was loaded`, 'FLEET_MEMBER_CHANGED', 409);
      }
      throw err;
    }
  },
};
