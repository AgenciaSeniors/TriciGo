import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emailVerificationHtml } from './email_verification.ts';
import { renderTemplate } from './index.ts';

// The token's lifetime is set where add-email-with-verification stores it
// (confirm-email only compares against the stored expires_at). Read it from
// there so the copy cannot drift from it again: it said "una hora" for a
// 24-hour token.
function storedTokenTtlHours(): number {
  const src = readFileSync(
    new URL('../../add-email-with-verification/index.ts', import.meta.url),
    'utf8',
  );
  const m = src.match(/expires_at:\s*new Date\(Date\.now\(\) \+ (\d+) \* 60 \* 60 \* 1000\)/);
  if (!m) throw new Error('could not find the token expires_at in add-email-with-verification');
  return Number(m[1]);
}

const DATA = { email: 'ana@example.com', verification_link: 'https://tricigo.com/auth/email-confirmed?token=abc' };

describe('email_verification template', () => {
  it('carries the address being confirmed and the link', () => {
    const html = emailVerificationHtml(DATA);

    expect(html).toContain('ana@example.com');
    expect(html).toContain(DATA.verification_link);
  });

  it('states the expiry the sender actually stores', () => {
    const hours = storedTokenTtlHours();
    const html = emailVerificationHtml(DATA);

    expect(html).toContain(`El enlace expira en ${hours} horas.`);
    expect(html).not.toMatch(/una hora/);
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
