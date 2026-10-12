// ============================================================
// Team of the admin panel (00660): members, invitations, roles.
// Every function is a SECURITY DEFINER RPC that checks the caller itself:
// super_admin for managing, anyone with the token for get_team_invitation,
// the signed-in person for accept_team_invitation.
// Spec: docs/superpowers/specs/2026-10-12-team-invitations-design.md
// ============================================================

import { parseAcceptOutcome, type AcceptInvitationOutcome } from '@tricigo/utils/teamInvitation';
import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

export type TeamRole = 'super_admin' | 'admin' | 'marketing';

export interface TeamMember {
  user_id: string;
  full_name: string;
  email: string | null;
  role: TeamRole;
  last_sign_in_at: string | null;
  /** Gets the daily digest: proven address and not opted out (00656). */
  gets_digest: boolean;
  is_me: boolean;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: TeamRole;
  full_name: string | null;
  invited_by_name: string;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  expired: boolean;
  link: string;
}

export interface TeamListing {
  members: TeamMember[];
  invitations: TeamInvitation[];
}

export interface InvitationSent {
  id: string;
  link: string;
  expires_at: string;
  /** false when the e-mail could not be queued: send the link another way. */
  email_queued: boolean;
}

export type PublicInvitationStatus = 'pending' | 'expired' | 'canceled' | 'accepted' | 'not_found';

export interface PublicInvitation {
  status: PublicInvitationStatus;
  role?: TeamRole;
  inviter_name?: string;
  email_masked?: string;
  expires_at?: string;
}

/**
 * The function's own Spanish message, with its team_* code from DETAIL. 400 on purpose:
 * getErrorMessage turns 401/403 into "Sesión expirada" and would hide the reason.
 */
function teamError(error: { code?: string; message?: string; details?: string | null }, rpc: string): AppError {
  if (error.code === 'PGRST202') {
    return new AppError('La base de datos todavía no tiene esta función. Avisa al equipo técnico.', 'RPC_MISSING', 400, { rpc });
  }
  return new AppError(error.message || 'Error inesperado. Intenta de nuevo.', error.details || error.code || 'RPC_ERROR', 400, {
    rpc,
    pgCode: error.code,
  });
}

async function call<T>(rpc: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabaseClient().rpc(rpc, args);
  if (error) throw teamError(error, rpc);
  return data as T;
}

export const teamService = {
  /** Members and pending invitations. Super admins only. */
  list(): Promise<TeamListing> {
    return call<TeamListing>('list_team');
  },

  invite(email: string, role: TeamRole, fullName?: string | null): Promise<InvitationSent> {
    return call<InvitationSent>('create_team_invitation', {
      p_email: email,
      p_role: role,
      p_full_name: fullName?.trim() ? fullName.trim() : null,
    });
  },

  /** Sends the e-mail again and restarts the 7 days. */
  resend(invitationId: string): Promise<InvitationSent> {
    return call<InvitationSent>('resend_team_invitation', { p_id: invitationId });
  },

  async cancel(invitationId: string): Promise<void> {
    await call<string>('cancel_team_invitation', { p_id: invitationId });
  },

  setRole(userId: string, role: TeamRole, reason: string): Promise<TeamRole> {
    return call<TeamRole>('set_team_member_role', { p_user: userId, p_role: role, p_reason: reason });
  },

  /** Takes the panel role away; answers the role the account goes back to. */
  remove(userId: string, reason: string): Promise<string> {
    return call<string>('remove_team_member', { p_user: userId, p_reason: reason });
  },

  /** The public invitation page. Works without a session. */
  getInvitation(token: string): Promise<PublicInvitation> {
    return call<PublicInvitation>('get_team_invitation', { p_token: token });
  },

  /** Accepts the caller's invitation (with its token, or the one for their Google address). */
  async accept(token?: string | null): Promise<AcceptInvitationOutcome> {
    return parseAcceptOutcome(await call<unknown>('accept_team_invitation', token ? { p_token: token } : {}));
  },
};
