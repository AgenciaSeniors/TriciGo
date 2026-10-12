// ============================================================
// TriciGo — Team invitation e-mail (00661)
//
// Sent by create_team_invitation and resend_team_invitation (SQL, through
// cron_http_post to send-email) to the address a super admin invited to the
// admin panel. data: { invitee_name, inviter_name, role, link, expires_at, email }.
// Only super admins write any of it; names are still escaped and kept to one line.
// Spec: docs/superpowers/specs/2026-10-12-team-invitations-design.md
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface TeamInvitationData {
  invitee_name: string;
  inviter_name: string;
  role: string;
  link: string;
  expires_at: string;
  email: string;
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Superadministrador',
  admin: 'Administrador',
  marketing: 'Marketing',
};

/** The only links this e-mail may carry: the panel's invitation page. */
const INVITATION_LINK = /^https:\/\/admin\.tricigo\.com\/invitacion\/[0-9a-f]{64}$/;
const FALLBACK_LINK = 'https://admin.tricigo.com/login';

export function teamRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? 'Equipo';
}

function oneLine(value: string | null | undefined, max = 80): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** '19 de octubre de 2026', in Havana time; '' for a date that does not parse. */
export function formatInvitationExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es', {
    timeZone: 'America/Havana',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function teamInvitationSubject(data: TeamInvitationData): string {
  const inviter = oneLine(data.inviter_name);
  const role = teamRoleLabel(data.role);
  return inviter
    ? `${inviter} te invitó al panel de TriciGo como ${role}`
    : `Te invitaron al panel de TriciGo como ${role}`;
}

export function teamInvitationHtml(data: TeamInvitationData): string {
  const name = oneLine(data.invitee_name);
  const inviter = oneLine(data.inviter_name);
  const role = teamRoleLabel(data.role);
  const expiry = formatInvitationExpiry(data.expires_at);
  const link = INVITATION_LINK.test(data.link) ? data.link : FALLBACK_LINK;
  const who = inviter ? `<strong>${escapeHtml(inviter)}</strong> te invitó` : 'Te invitaron';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      ${name ? `Hola, ${escapeHtml(name)}:` : 'Hola:'}
    </p>
    <p style="margin: 0 0 16px;">
      ${who} al panel de administración de TriciGo con el rol <strong>${escapeHtml(role)}</strong>.
    </p>
    <p style="margin: 0 0 16px;">
      Toca el botón y entra con la cuenta de Google de <strong>${escapeHtml(data.email)}</strong>.
      Con otra cuenta la invitación no funciona.
    </p>
    ${expiry ? `<p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.muted};">La invitación vence el ${escapeHtml(expiry)}.</p>` : ''}
    <p style="margin: 0;">
      Si no esperabas esta invitación, ignora este correo.
    </p>
  `;

  return wrapHtml({
    preheader: `Invitación al panel de TriciGo como ${role}.`,
    hero: {
      title: 'Te invitaron al equipo',
      subtitle: 'Panel de administración de TriciGo',
    },
    body,
    cta: { label: 'Entrar al panel', href: link },
    footerNote: '¿Dudas? Escríbenos a soporte@tricigo.com',
  });
}
