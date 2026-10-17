// ============================================================
// Team of the admin panel (00661): members, invitations, roles.
// Every function is a SECURITY DEFINER RPC that checks the caller itself:
// super_admin for managing, anyone with the token for get_team_invitation,
// the signed-in person for accept_team_invitation. Accepting with an e-mail code
// (00664) goes through the Edge Function team-invitation-code instead.
// Spec: docs/superpowers/specs/2026-10-12-team-invitations-design.md
// and docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
// ============================================================

import {
  invitationCodeMessage,
  parseAcceptOutcome,
  parseInvitationCodeAnswer,
  type AcceptInvitationOutcome,
  type InvitationCodeAnswer,
} from '@tricigo/utils/teamInvitation';
import { isPanelRole, type PanelRole } from '@tricigo/utils/adminPanelAccess';
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

export interface InvitationCodeSent {
  /** The invited address already has a TriciGo account: the form does not ask for the name. */
  accountExists: boolean;
  expiresInS: number;
  /** The name the super_admin typed in the invitation, to prefill the form ('' when none). */
  inviteeName: string;
}

export interface InvitationCodeAccepted {
  /** The full invited address: the page signs in with it and the chosen password. */
  email: string;
  role: PanelRole;
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

/** An answer of team-invitation-code that is not a success, as a 400 AppError with its Spanish text. */
function invitationCodeError(answer: InvitationCodeAnswer): AppError {
  return new AppError(invitationCodeMessage(answer), `invitation_${answer.result}`, 400, {
    result: answer.result,
    retryAfterS: answer.retryAfterS,
  });
}

/**
 * The wait of a 429 from rateLimitResponse (supabase/functions/_shared/rate-limiter.ts): the
 * Retry-After header (exposed to the browser), or retryAfterSec in the body. null when neither.
 */
async function retryAfterSeconds(res: Response): Promise<number | null> {
  const header = Number(res.headers?.get?.('Retry-After'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  try {
    const body: unknown = await res.clone().json();
    const sec = (body as { retryAfterSec?: unknown } | null)?.retryAfterSec;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec > 0) return Math.ceil(sec);
  } catch {
    /* body unreadable or already read: the wait stays unknown */
  }
  return null;
}

/**
 * Calls team-invitation-code (verify_jwt = false: the person has no session yet, so the call
 * goes with the publishable key). Every outcome comes back 200 { result }; a non-2xx is the
 * per-IP limiter (429), a malformed request (400) or a failure (500). A FunctionsFetchError
 * means the request never got an answer (no connection, or the browser blocked it).
 */
async function invokeInvitationCode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient().functions.invoke('team-invitation-code', { body });
  if (error) {
    const failed = error as { name?: unknown; context?: unknown };
    // By name, not instanceof: two copies of supabase-js in a bundle would break instanceof.
    if (failed.name === 'FunctionsFetchError') {
      throw invitationCodeError({ result: 'network', retryAfterS: null, attemptsLeft: null });
    }
    const res = failed.context as Response | undefined;
    if (res && typeof res === 'object' && res.status === 429) {
      throw invitationCodeError({ result: 'rate_limited', retryAfterS: await retryAfterSeconds(res), attemptsLeft: null });
    }
    throw invitationCodeError({ result: 'error', retryAfterS: null, attemptsLeft: null });
  }
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
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

  /** Mails a code to the invited address (00664). Works without a session. */
  async requestInvitationCode(token: string): Promise<InvitationCodeSent> {
    const raw = await invokeInvitationCode({ action: 'send', token });
    const answer = parseInvitationCodeAnswer(raw);
    if (answer.result !== 'sent') throw invitationCodeError(answer);
    return {
      accountExists: raw.account_exists === true,
      expiresInS: typeof raw.expires_in_s === 'number' ? raw.expires_in_s : 600,
      inviteeName: typeof raw.invitee_name === 'string' ? raw.invitee_name : '',
    };
  },

  /** Checks the code, creates the account or sets its password, and accepts the invitation. */
  async acceptInvitationWithCode(input: {
    token: string;
    code: string;
    password: string;
    fullName?: string | null;
  }): Promise<InvitationCodeAccepted> {
    const body: Record<string, unknown> = {
      action: 'verify',
      token: input.token,
      code: input.code.trim(),
      password: input.password,
    };
    const name = input.fullName?.trim();
    if (name) body.full_name = name;
    const raw = await invokeInvitationCode(body);
    const answer = parseInvitationCodeAnswer(raw);
    if (answer.result !== 'accepted') throw invitationCodeError(answer);
    if (typeof raw.email !== 'string' || !raw.email || !isPanelRole(raw.role)) {
      throw invitationCodeError({ ...answer, result: 'try_again' });
    }
    return { email: raw.email, role: raw.role };
  },
};
