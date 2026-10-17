import { describe, expect, it } from 'vitest';
import { teamInvitationCodeHtml, teamInvitationCodeSubject } from './team_invitation_code.ts';
import { isTemplateKey, renderTemplate } from './index.ts';

// wrapHtml turns every non-ASCII character into a numeric entity; decode them to read the text.
const decode = (html: string) => html.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

const DATA = { code: '048213', email: 'info@bacoagency.com' };

describe('team_invitation_code template', () => {
  it('has a fixed subject', () => {
    expect(teamInvitationCodeSubject).toBe('Tu código para el panel de TriciGo');
  });

  it('shows the code, the address and the expiry', () => {
    const html = decode(teamInvitationCodeHtml(DATA));
    expect(html).toContain('048213');
    expect(html).toContain('info@bacoagency.com');
    expect(html).toContain('Vence en 10 minutos.');
    expect(html).toContain('Si no pediste este código, ignora este correo.');
  });

  it('shows nothing that is not a 6-digit code', () => {
    const html = teamInvitationCodeHtml({ ...DATA, code: '<b>12</b>' });
    expect(html).not.toContain('<b>12');
    expect(html).not.toContain('&lt;b&gt;12');
  });

  it('escapes the address', () => {
    const html = teamInvitationCodeHtml({ ...DATA, email: '<script>x</script>@evil.example' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is registered in the template index', () => {
    expect(isTemplateKey('team_invitation_code')).toBe(true);
    const rendered = renderTemplate('team_invitation_code', DATA);
    expect(rendered.subject).toBe('Tu código para el panel de TriciGo');
    expect(decode(rendered.html)).toContain('048213');
  });
});
