import { describe, expect, it } from 'vitest';
import { emailVerificationHtml } from './email_verification.ts';
import { renderTemplate } from './index.ts';

const DATA = { email: 'ana@example.com', verification_link: 'https://tricigo.com/auth/email-confirmed?token=abc' };

describe('email_verification template', () => {
  it('carries the address being confirmed and the link', () => {
    const html = emailVerificationHtml(DATA);

    expect(html).toContain('ana@example.com');
    expect(html).toContain(DATA.verification_link);
  });

  // The recipient is whatever address the account typed, so it can be anyone's.
  // full_name is written by the account's owner: rendered here, it put that
  // owner's own text in an e-mail from noreply@tricigo.com to a stranger.
  it('does not render a full_name even if a caller still passes one', () => {
    const legacy = { ...DATA, full_name: 'Tu cuenta fue suspendida, entra en evil.example' };

    expect(emailVerificationHtml(legacy as typeof DATA)).not.toContain('evil.example');
    expect(renderTemplate('email_verification', legacy).html).not.toContain('evil.example');
  });
});
