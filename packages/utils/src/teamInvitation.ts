/**
 * Team invitations (00660): what accept_team_invitation answers and where that sends someone.
 * Imported as `@tricigo/utils/teamInvitation` so the admin middleware does not load the barrel.
 * Spec: docs/superpowers/specs/2026-10-12-team-invitations-design.md
 */
import { isPanelRole, panelHome, type PanelRole } from './adminPanelAccess';

export const ACCEPT_RESULTS = [
  'accepted',
  'wrong_account',
  'needs_google',
  'expired',
  'canceled',
  'used',
  'blocked',
  'not_found',
  'none',
] as const;

export type AcceptInvitationResult = (typeof ACCEPT_RESULTS)[number];

/** Every result except 'accepted': the reasons /sin-acceso explains. */
export type NoAccessReason = Exclude<AcceptInvitationResult, 'accepted'>;

export interface AcceptInvitationOutcome {
  result: AcceptInvitationResult;
  role: PanelRole | null;
  emailMasked: string | null;
}

/** Reads what accept_team_invitation returned. Anything unexpected is 'none'. */
export function parseAcceptOutcome(raw: unknown): AcceptInvitationOutcome {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = (ACCEPT_RESULTS as readonly string[]).includes(obj.result as string)
    ? (obj.result as AcceptInvitationResult)
    : 'none';
  const role = isPanelRole(obj.role) ? obj.role : null;
  const emailMasked = typeof obj.email_masked === 'string' && obj.email_masked ? obj.email_masked : null;
  if (result === 'accepted' && !role) return { result: 'none', role: null, emailMasked: null };
  return { result, role, emailMasked };
}

/** Where to go next: the role's home when accepted, /sin-acceso with the reason otherwise. */
export function invitationOutcomePath(outcome: AcceptInvitationOutcome): string {
  if (outcome.result === 'accepted' && outcome.role) return panelHome(outcome.role);
  const params = new URLSearchParams({ reason: outcome.result === 'accepted' ? 'none' : outcome.result });
  if (outcome.emailMasked) params.set('email', outcome.emailMasked);
  return `/sin-acceso?${params.toString()}`;
}

/** The reason in /sin-acceso's URL; anything else reads as 'none'. */
export function noAccessReason(raw: string | null | undefined): NoAccessReason {
  return raw && raw !== 'accepted' && (ACCEPT_RESULTS as readonly string[]).includes(raw)
    ? (raw as NoAccessReason)
    : 'none';
}

/** A token as the invitation link carries it: 64 lowercase hex characters. */
export function isInvitationToken(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw);
}
