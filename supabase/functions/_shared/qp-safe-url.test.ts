import { describe, expect, it } from 'vitest';
import { qpSafeUrl } from './qp-safe-url';

// El caso real del E2E 2026-08-18: `?token=42f8…` llegó como `?tokenBf8…`
// porque la cadena de entrega decodificó `=42` como escape quoted-printable
// (byte 0x42 = 'B'). La armadura debe hacer imposible ese escape sin cambiar
// el significado de la URL.
describe('qpSafeUrl', () => {
  const OBSERVED_BUG_URL =
    'https://tricigo.com/auth/email-confirmed?token=42f8bcff025a798f46d763068ff8c31238b75cabc3717b70e8502648afc3f541';

  it('arms the exact link that arrived corrupted in the E2E', () => {
    const armored = qpSafeUrl(OBSERVED_BUG_URL);
    // El '4' capturado se sustituye por su percent-encoding (%34); el resto sigue.
    expect(armored).toBe(
      'https://tricigo.com/auth/email-confirmed?token=%342f8bcff025a798f46d763068ff8c31238b75cabc3717b70e8502648afc3f541',
    );
  });

  it('never leaves an = followed by two hex chars (the QP escape shape)', () => {
    const urls = [
      OBSERVED_BUG_URL,
      'https://auth.tricigo.com/auth/v1/verify?token=f577db8274bd5d7d47f34ed002ddf46513afa069dc3f381cefb867c9&type=magiclink&redirect_to=tricigo-driver://auth/callback',
      'https://x.test/?a=00&b=ff&c=AA',
    ];
    for (const url of urls) {
      expect(qpSafeUrl(url)).not.toMatch(/=[0-9a-fA-F]{2}/);
    }
  });

  it('URL-decodes back to the original (semantics unchanged)', () => {
    const armored = qpSafeUrl(OBSERVED_BUG_URL);
    expect(decodeURIComponent(armored)).toBe(OBSERVED_BUG_URL);
    const token = new URL(armored).searchParams.get('token');
    expect(token).toBe('42f8bcff025a798f46d763068ff8c31238b75cabc3717b70e8502648afc3f541');
  });

  it('leaves QP-safe params untouched (pkce_, type=magiclink, redirect_to)', () => {
    const url =
      'https://auth.tricigo.com/auth/v1/verify?token=pkce_abc123&type=magiclink&redirect_to=tricigo-driver://auth/callback';
    expect(qpSafeUrl(url)).toBe(url);
  });

  it('leaves = at end of string or before a single hex char untouched', () => {
    expect(qpSafeUrl('https://x.test/?a=')).toBe('https://x.test/?a=');
    expect(qpSafeUrl('https://x.test/?a=f')).toBe('https://x.test/?a=f');
    expect(qpSafeUrl('https://x.test/?a=fz')).toBe('https://x.test/?a=fz');
  });

  it('arms every vulnerable = in the URL, not just the first', () => {
    const armored = qpSafeUrl('https://x.test/?a=12&b=cd');
    expect(armored).toBe('https://x.test/?a=%312&b=%63d');
    expect(decodeURIComponent(armored)).toBe('https://x.test/?a=12&b=cd');
  });
});
