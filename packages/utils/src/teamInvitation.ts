/**
 * Team invitations (00661): what accept_team_invitation answers and where that sends someone.
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

/**
 * The address in /sin-acceso's URL, only in the shape _team_mask_email produces ('l…@gmail.com').
 * Anything else is null, so a crafted link cannot put its own text on the page.
 */
export function maskedEmailParam(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return /^[\p{L}\p{N}._%+'-]…@(?=.{3,253}$)(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+$/u.test(raw) ? raw : null;
}

/**
 * What the Edge Function team-invitation-code answers (00664): its own results, the ones it
 * passes on from team_invitation_code_issue / _check / accept_team_invitation_by_code, and three
 * the page derives itself: 'rate_limited' (HTTP 429 from the per-IP limiter), 'network' (the
 * request never reached the function) and 'error'.
 * The SQL answers 'issued' and 'ok' never reach the page: the function turns them into
 * 'sent' and 'accepted'.
 */
export const INVITATION_CODE_RESULTS = [
  'sent',
  'accepted',
  'cooldown',
  'too_many_hour',
  'too_many_day',
  'send_failed',
  'wrong_code',
  'locked',
  'code_expired',
  'no_code',
  'bad_password',
  'bad_name',
  'weak_password',
  'needs_google',
  'blocked',
  'internal_address',
  'expired',
  'canceled',
  'used',
  'not_found',
  'wrong_account',
  'no_account',
  'try_again',
  'rate_limited',
  'network',
  'error',
] as const;

export type InvitationCodeResult = (typeof INVITATION_CODE_RESULTS)[number];

export interface InvitationCodeAnswer {
  result: InvitationCodeResult;
  retryAfterS: number | null;
  attemptsLeft: number | null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Reads what team-invitation-code answered. Anything unexpected is 'error'. */
export function parseInvitationCodeAnswer(raw: unknown): InvitationCodeAnswer {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = (INVITATION_CODE_RESULTS as readonly string[]).includes(obj.result as string)
    ? (obj.result as InvitationCodeResult)
    : 'error';
  return { result, retryAfterS: nonNegativeInt(obj.retry_after_s), attemptsLeft: nonNegativeInt(obj.attempts_left) };
}

/**
 * A wait as "N minutos" / "1 minuto", or in hours ("N horas" / "1 hora") once it rounds up to
 * 60 minutes or more, so it never reads "60 minutos". null when the wait is unknown.
 */
function waitPhrase(seconds: number | null): string | null {
  if (!seconds) return null;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  const hours = Math.ceil(seconds / 3600);
  return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}

/** The text the invitation page shows for an answer that is not a success. */
export function invitationCodeMessage(answer: InvitationCodeAnswer): string {
  const seconds = answer.retryAfterS;
  const wait = waitPhrase(seconds);
  switch (answer.result) {
    case 'cooldown':
      return seconds && seconds > 1
        ? `Espera ${seconds} segundos para pedir otro código.`
        : 'Espera un momento para pedir otro código.';
    case 'too_many_hour':
      return wait
        ? `Pediste muchos códigos en la última hora. Vuelve a intentarlo en ${wait}.`
        : 'Pediste muchos códigos en la última hora. Vuelve a intentarlo más tarde.';
    case 'too_many_day':
      // check_rate_limit windows are aligned to the epoch: the day opens again at 00:00 UTC
      // (20:00 or 19:00 in Havana), so "mañana" would be wrong.
      return wait
        ? `Ya se pidieron 10 códigos para esta invitación. Vuelve a intentarlo en ${wait}.`
        : 'Ya se pidieron 10 códigos para esta invitación. Vuelve a intentarlo más tarde.';
    case 'send_failed':
      return 'No pudimos mandar el correo. Intenta de nuevo en un rato.';
    case 'wrong_code': {
      const left = answer.attemptsLeft;
      if (left === 1) return 'El código no es correcto. Te queda 1 intento.';
      return left ? `El código no es correcto. Te quedan ${left} intentos.` : 'El código no es correcto.';
    }
    case 'locked':
      return 'Probaste demasiadas veces con este código. Pide uno nuevo.';
    case 'code_expired':
      return 'El código venció. Pide uno nuevo.';
    case 'no_code':
      return 'Primero pide un código.';
    case 'bad_password':
      // The server counts 72 bytes, not characters (bcrypt), and an accented letter takes two:
      // promising "72 caracteres" would be wrong for a password with accents.
      return 'La contraseña tiene que tener al menos 8 caracteres y no puede ser demasiado larga.';
    case 'bad_name':
      return 'El nombre puede tener hasta 80 caracteres.';
    case 'weak_password':
      // The code is already spent when GoTrue refuses the password.
      return 'Esa contraseña es muy fácil de adivinar. Elige otra y pide un código nuevo.';
    case 'needs_google':
      // Covers a phone (confirmed or not), another identity, and an address that only another
      // account's identity carries.
      return 'Este correo ya está en una cuenta que entra de otra forma, como un teléfono o Google. Para aceptar, entra con Google con este correo.';
    case 'blocked':
      return 'Tu cuenta está bloqueada.';
    case 'internal_address':
      return 'Esta invitación no se puede aceptar con un código. Entra con Google.';
    case 'expired':
      return 'La invitación venció. Pídele a quien te invitó que te mande una nueva.';
    case 'canceled':
      return 'La invitación fue cancelada. Si crees que es un error, pídele a quien te invitó una nueva.';
    case 'used':
      return 'Esta invitación ya se usó. Entra desde la página de inicio de sesión.';
    case 'not_found':
      return 'No encontramos esa invitación. Revisa el enlace o pide uno nuevo.';
    case 'rate_limited':
      return wait
        ? `Hubo demasiados intentos desde esta conexión. Vuelve a intentarlo en ${wait}.`
        : 'Hubo demasiados intentos desde esta conexión. Espera un rato y vuelve a intentarlo.';
    case 'network':
      return 'Sin conexión a internet. Revisa tu conexión y vuelve a intentarlo.';
    case 'wrong_account':
    case 'no_account':
    case 'try_again':
      return 'Algo cambió mientras preparábamos tu cuenta. Pide un código nuevo y vuelve a intentarlo.';
    default:
      return 'Algo salió mal. Intenta de nuevo.';
  }
}
