import { describe, expect, it } from 'vitest';
import {
  INVITATION_CODE_RESULTS,
  invitationCodeMessage,
  invitationOutcomePath,
  isInvitationToken,
  maskedEmailParam,
  noAccessReason,
  parseAcceptOutcome,
  parseInvitationCodeAnswer,
} from '../teamInvitation';

describe('parseAcceptOutcome', () => {
  it('reads an accepted invitation with its role', () => {
    expect(parseAcceptOutcome({ result: 'accepted', role: 'marketing' })).toEqual({
      result: 'accepted', role: 'marketing', emailMasked: null,
    });
  });

  it('keeps the masked address of a wrong account', () => {
    expect(parseAcceptOutcome({ result: 'wrong_account', email_masked: 'l…@gmail.com' })).toEqual({
      result: 'wrong_account', role: null, emailMasked: 'l…@gmail.com',
    });
  });

  it('turns anything unexpected into none', () => {
    for (const raw of [null, undefined, 'accepted', 42, {}, { result: 'hacked' }, { result: 'accepted', role: 'customer' }]) {
      expect(parseAcceptOutcome(raw).result).toBe('none');
    }
  });
});

describe('invitationOutcomePath', () => {
  it('sends an accepted person to their role home', () => {
    expect(invitationOutcomePath({ result: 'accepted', role: 'admin', emailMasked: null })).toBe('/');
    expect(invitationOutcomePath({ result: 'accepted', role: 'marketing', emailMasked: null })).toBe('/launch-pulse');
  });

  it('sends everyone else to /sin-acceso with the reason and the masked address', () => {
    expect(invitationOutcomePath({ result: 'wrong_account', role: null, emailMasked: 'l…@gmail.com' })).toBe(
      '/sin-acceso?reason=wrong_account&email=l%E2%80%A6%40gmail.com',
    );
    expect(invitationOutcomePath({ result: 'none', role: null, emailMasked: null })).toBe('/sin-acceso?reason=none');
  });
});

describe('noAccessReason', () => {
  it('accepts the known reasons and nothing else', () => {
    expect(noAccessReason('expired')).toBe('expired');
    expect(noAccessReason('needs_google')).toBe('needs_google');
    for (const raw of [null, '', 'accepted', 'whatever']) expect(noAccessReason(raw)).toBe('none');
  });
});

describe('isInvitationToken', () => {
  it('is 64 lowercase hex characters', () => {
    expect(isInvitationToken('a'.repeat(64))).toBe(true);
    for (const raw of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', null, undefined]) {
      expect(isInvitationToken(raw)).toBe(false);
    }
  });
});

describe('maskedEmailParam', () => {
  it('keeps an address masked like _team_mask_email', () => {
    expect(maskedEmailParam('l…@gmail.com')).toBe('l…@gmail.com');
    expect(maskedEmailParam('9…@correo.tricigo.cu')).toBe('9…@correo.tricigo.cu');
    expect(maskedEmailParam('m…@münchen.de')).toBe('m…@münchen.de');
  });

  it('drops anything else, so a crafted link cannot put its own text on the page', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'lucia@gmail.com',
      '…@gmail.com',
      'l…@gmail',
      'l… @gmail.com',
      'l…@gmail.com y llama al +5355555555',
      'l…@gmail.com/login',
      'l…@evil..com',
      `l…@${'a'.repeat(250)}.com`,
    ]) {
      expect(maskedEmailParam(raw)).toBeNull();
    }
  });
});

describe('parseInvitationCodeAnswer', () => {
  it('reads the result, the seconds and the attempts', () => {
    expect(parseInvitationCodeAnswer({ result: 'cooldown', retry_after_s: 42 })).toEqual({
      result: 'cooldown',
      retryAfterS: 42,
      attemptsLeft: null,
    });
    expect(parseInvitationCodeAnswer({ result: 'wrong_code', attempts_left: 3 })).toEqual({
      result: 'wrong_code',
      retryAfterS: null,
      attemptsLeft: 3,
    });
  });

  it('turns anything unexpected into error', () => {
    expect(parseInvitationCodeAnswer(null).result).toBe('error');
    expect(parseInvitationCodeAnswer({ result: 'pwned' }).result).toBe('error');
    expect(parseInvitationCodeAnswer({ result: 'cooldown', retry_after_s: -1 }).retryAfterS).toBeNull();
  });

  it('never passes on the internal answers of the SQL functions', () => {
    // team_invitation_code_issue answers 'issued' and _check 'ok'; the Edge Function turns them
    // into 'sent' / 'accepted', so reaching the page as they are means something broke.
    expect(parseInvitationCodeAnswer({ result: 'issued' }).result).toBe('error');
    expect(parseInvitationCodeAnswer({ result: 'ok' }).result).toBe('error');
  });
});

describe('invitationCodeMessage', () => {
  const msg = (result: string, extra: Record<string, unknown> = {}) =>
    invitationCodeMessage(parseInvitationCodeAnswer({ result, ...extra }));

  it('says how long to wait', () => {
    expect(msg('cooldown', { retry_after_s: 42 })).toBe('Espera 42 segundos para pedir otro código.');
    expect(msg('cooldown', { retry_after_s: 1 })).toBe('Espera un momento para pedir otro código.');
    expect(msg('too_many_hour', { retry_after_s: 61 })).toBe(
      'Pediste muchos códigos en la última hora. Vuelve a intentarlo en 2 minutos.',
    );
    expect(msg('too_many_hour', { retry_after_s: 30 })).toBe(
      'Pediste muchos códigos en la última hora. Vuelve a intentarlo en 1 minuto.',
    );
    expect(msg('too_many_day')).toBe('Ya pediste 10 códigos hoy. Vuelve a intentarlo mañana.');
  });

  it('counts the attempts left', () => {
    expect(msg('wrong_code', { attempts_left: 3 })).toBe('El código no es correcto. Te quedan 3 intentos.');
    expect(msg('wrong_code', { attempts_left: 1 })).toBe('El código no es correcto. Te queda 1 intento.');
  });

  it('explains the refusals', () => {
    expect(msg('needs_google')).toBe(
      'Esta cuenta también entra con un teléfono. Para aceptar, entra con Google con este correo.',
    );
    expect(msg('blocked')).toBe('Tu cuenta está bloqueada.');
    expect(msg('locked')).toBe('Probaste demasiadas veces con este código. Pide uno nuevo.');
    expect(msg('expired')).toBe('La invitación venció. Pídele a quien te invitó que te mande una nueva.');
    expect(msg('try_again')).toBe('Algo cambió mientras preparábamos tu cuenta. Pide un código nuevo y vuelve a intentarlo.');
    expect(msg('weak_password')).toBe('Esa contraseña es muy fácil de adivinar. Elige otra y pide un código nuevo.');
    expect(msg('error')).toBe('Algo salió mal. Intenta de nuevo.');
  });

  it('does not promise 72 characters: the server counts 72 bytes, and an accent takes two', () => {
    expect(msg('bad_password')).toBe('La contraseña tiene que tener al menos 8 caracteres y no puede ser demasiado larga.');
  });

  it('has its own text for every refusal the function can answer', () => {
    const generic = msg('error');
    for (const result of INVITATION_CODE_RESULTS) {
      if (result === 'sent' || result === 'accepted' || result === 'error') continue;
      expect(msg(result), result).not.toBe(generic);
    }
  });
});
