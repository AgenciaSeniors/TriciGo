import { describe, expect, it } from 'vitest';
import {
  formatInvitationExpiry,
  teamInvitationHtml,
  teamInvitationSubject,
  teamRoleLabel,
} from './team_invitation.ts';
import { isTemplateKey, renderTemplate } from './index.ts';

// wrapHtml turns every non-ASCII character into a numeric entity; decode them to read the text.
const decode = (html: string) => html.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

const TOKEN = 'a'.repeat(64);
const DATA = {
  invitee_name: 'Lucía',
  inviter_name: 'Eduardo',
  role: 'admin',
  link: `https://admin.tricigo.com/invitacion/${TOKEN}`,
  expires_at: '2026-10-19T15:00:00Z',
  email: 'lucia@gmail.com',
};

describe('team_invitation template', () => {
  it('names who invited, with which role', () => {
    expect(teamInvitationSubject(DATA)).toBe('Eduardo te invitó al panel de TriciGo como Administrador');
    expect(teamInvitationSubject({ ...DATA, inviter_name: '  ', role: 'marketing' })).toBe(
      'Te invitaron al panel de TriciGo como Marketing',
    );
  });

  it('keeps a name on one line in the subject', () => {
    expect(teamInvitationSubject({ ...DATA, inviter_name: 'Eduardo\r\nBcc: x@evil.example' })).toBe(
      'Eduardo Bcc: x@evil.example te invitó al panel de TriciGo como Administrador',
    );
  });

  it('carries the link, the invited address, the role and the expiry in Havana time', () => {
    const html = decode(teamInvitationHtml(DATA));
    expect(html).toContain(DATA.link);
    expect(html).toContain('lucia@gmail.com');
    expect(html).toContain('Administrador');
    expect(html).toContain('La invitación vence el 19 de octubre de 2026.');
    expect(html).toContain('Si no esperabas esta invitación, ignora este correo.');
    expect(html).toContain('o crea tu cuenta con un código que te mandamos a esta dirección.');
    expect(html).not.toContain('Con otra cuenta la invitación no funciona.');
  });

  it('escapes the names', () => {
    const html = teamInvitationHtml({ ...DATA, invitee_name: '<script>x</script>', inviter_name: '<b>Eve</b>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Eve</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('only links to the invitation page', () => {
    const html = teamInvitationHtml({ ...DATA, link: 'https://evil.example/invitacion/' + TOKEN });
    expect(html).not.toContain('evil.example');
    expect(html).toContain('https://admin.tricigo.com/login');
  });

  it('labels the three roles and leaves out an unknown expiry', () => {
    expect(['super_admin', 'admin', 'marketing'].map(teamRoleLabel)).toEqual([
      'Superadministrador',
      'Administrador',
      'Marketing',
    ]);
    expect(formatInvitationExpiry('nope')).toBe('');
    expect(teamInvitationHtml({ ...DATA, expires_at: 'nope' })).not.toContain('vence');
  });

  it('is in the send-email registry', () => {
    expect(isTemplateKey('team_invitation')).toBe(true);
    const rendered = renderTemplate('team_invitation', DATA);
    expect(rendered.subject).toBe('Eduardo te invitó al panel de TriciGo como Administrador');
    expect(rendered.html).toContain(DATA.link);
  });
});
