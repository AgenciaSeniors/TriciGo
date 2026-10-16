'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@tricigo/i18n';
import { teamService, type InvitationCodeAccepted } from '@tricigo/api';
import { panelHome } from '@tricigo/utils/adminPanelAccess';
import { createBrowserClient } from '@/lib/supabase-server';

/** Seconds before "Enviar otro código" comes back: the server's own cooldown (00664). */
const RESEND_AFTER_S = 60;
/** GoTrue (bcrypt) counts bytes, and the server refuses more than 72 before spending the code. */
const MAX_PASSWORD_BYTES = 72;

/** Answers after which the code no longer works: the field empties and the person asks for a new one. */
const CODE_GONE = new Set(['weak_password', 'try_again', 'wrong_account', 'no_account', 'locked', 'code_expired', 'no_code']);
/** Answers after which this invitation cannot be accepted with a code at all: the form closes. */
const FORM_CLOSED = new Set(['expired', 'canceled', 'used', 'not_found', 'blocked', 'needs_google', 'internal_address']);

const INPUT =
  'w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm';
const PRIMARY =
  'w-full py-2.5 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors';
const LABEL = 'block text-sm font-medium text-neutral-300 mb-1';

interface CodeFailure {
  message: string;
  /** The answer of team-invitation-code (details.result of teamService's AppError), when known. */
  result: string | null;
  retryAfterS: number | null;
}

/**
 * teamService throws an AppError whose message is the Spanish text of the answer
 * (invitationCodeMessage). Anything else gets the generic text, never a raw technical one.
 */
function readFailure(err: unknown, fallback: string): CodeFailure {
  const details = (err as { details?: { result?: unknown; retryAfterS?: unknown } } | null)?.details;
  const result = typeof details?.result === 'string' ? details.result : null;
  const retry = details?.retryAfterS;
  return {
    message: result && err instanceof Error && err.message ? err.message : fallback,
    result,
    retryAfterS: typeof retry === 'number' && retry > 0 ? retry : null,
  };
}

/** A wait for the button label: "45 s", "3 min" or "2 h" (same units in es/en/pt). */
function waitLabel(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

interface InvitationCodeFormProps {
  token: string;
  emailMasked: string;
}

/**
 * The second way to accept an invitation (00664): a code sent to the invited address and a
 * password. On success it signs in with that password and goes to the person's panel home.
 */
export function InvitationCodeForm({ token, emailMasked }: InvitationCodeFormProps) {
  const { t } = useTranslation('admin');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [accountExists, setAccountExists] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** The invitation was accepted: the code is spent and the form goes away. */
  const [done, setDone] = useState(false);
  /** The invitation cannot be accepted with a code (expired, used, needs Google…). */
  const [closed, setClosed] = useState(false);
  /** When a code can be asked for again (epoch ms), and the clock the countdown reads. */
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [notice, setNotice] = useState('');

  // Ticks from the real clock, not by counting down: a background tab slows timers down.
  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const id = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendAt) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendAt]);

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  /** Keeps the send buttons off for at least this long (a longer wait already set wins). */
  const holdSending = (seconds: number) => {
    const current = Date.now();
    setNow(current);
    setResendAt((previous) => Math.max(previous, current + seconds * 1000));
  };

  const generic = () => t('invitation.code_error', { defaultValue: 'Algo salió mal. Intenta de nuevo.' });

  const sendCode = async () => {
    const again = sent;
    setSending(true);
    setError('');
    setInfo('');
    try {
      const res = await teamService.requestInvitationCode(token);
      setAccountExists(res.accountExists);
      if (res.inviteeName) setName((current) => current || res.inviteeName);
      setCode('');
      setSent(true);
      holdSending(RESEND_AFTER_S);
      if (again) {
        setInfo(
          t('invitation.code_resent', { defaultValue: 'Te mandamos un código nuevo. El anterior ya no sirve.' }),
        );
      }
    } catch (err) {
      const failure = readFailure(err, generic());
      setError(failure.message);
      if (failure.retryAfterS) holdSending(failure.retryAfterS);
      if (failure.result && FORM_CLOSED.has(failure.result)) setClosed(true);
    } finally {
      setSending(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || done) return;
    setError('');
    setInfo('');
    // Every space goes, as on the server: a pasted "048 213" is a valid code.
    const cleanCode = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) {
      setError(t('invitation.code_missing', { defaultValue: 'Escribe el código de 6 dígitos.' }));
      return;
    }
    if (!accountExists && !name.trim()) {
      setError(t('invitation.code_name_missing', { defaultValue: 'Escribe tu nombre.' }));
      return;
    }
    if (password.length < 8) {
      setError(t('invitation.code_too_short', { defaultValue: 'La contraseña tiene que tener al menos 8 caracteres.' }));
      return;
    }
    if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
      setError(t('invitation.code_too_long', { defaultValue: 'La contraseña es demasiado larga.' }));
      return;
    }
    if (password !== repeat) {
      setError(t('invitation.code_mismatch', { defaultValue: 'Las contraseñas no coinciden.' }));
      return;
    }

    setSubmitting(true);
    let accepted: InvitationCodeAccepted;
    try {
      accepted = await teamService.acceptInvitationWithCode({
        token,
        code: cleanCode,
        password,
        fullName: accountExists ? null : name,
      });
    } catch (err) {
      const failure = readFailure(err, generic());
      setError(failure.message);
      if (failure.result && CODE_GONE.has(failure.result)) setCode('');
      if (failure.result === 'weak_password') {
        setPassword('');
        setRepeat('');
      }
      if (failure.result && FORM_CLOSED.has(failure.result)) setClosed(true);
      setSubmitting(false);
      return;
    }

    // From here the account exists and the invitation is accepted, whatever the sign-in does.
    setDone(true);
    let signedIn = false;
    try {
      const { error: signInError } = await createBrowserClient().auth.signInWithPassword({
        email: accepted.email,
        password,
      });
      signedIn = !signInError;
    } catch {
      signedIn = false;
    }
    if (!signedIn) {
      setSubmitting(false);
      setNotice(
        t('invitation.code_signin_fallback', {
          defaultValue:
            'Tu cuenta quedó lista, pero no pudimos iniciar sesión. Entra en la página de inicio de sesión con tu correo y tu contraseña.',
        }),
      );
      return;
    }
    // replace: Back must not return to an invitation that is already used.
    router.replace(panelHome(accepted.role));
    router.refresh();
  };

  if (!open && !closed) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-neutral-700 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
      >
        {t('invitation.code_option', { defaultValue: 'Crear cuenta con un código' })}
      </button>
    );
  }

  return (
    <div className="space-y-3 border-t border-neutral-800 pt-4">
      {closed ? null : done ? (
        !notice && (
          <p role="status" aria-live="polite">
            {t('invitation.code_submitting', { defaultValue: 'Entrando…' })}
          </p>
        )
      ) : !sent ? (
        <>
          <p>
            {t('invitation.code_intro', {
              defaultValue: 'Te mandamos un código de 6 dígitos a {{email}}.',
              email: emailMasked,
            })}
          </p>
          <button type="button" onClick={() => void sendCode()} disabled={sending || wait > 0} className={PRIMARY}>
            {sending
              ? t('invitation.code_sending', { defaultValue: 'Enviando…' })
              : wait > 0
                ? t('invitation.code_send_in', { defaultValue: 'Enviar código ({{wait}})', wait: waitLabel(wait) })
                : t('invitation.code_send', { defaultValue: 'Enviar código' })}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <p>
            {t('invitation.code_sent', {
              defaultValue: 'Te mandamos el código a {{email}}. Vence en 10 minutos.',
              email: emailMasked,
            })}
          </p>
          {accountExists && (
            <p className="text-neutral-400">
              {t('invitation.code_existing', {
                defaultValue: 'Ya hay una cuenta con este correo: elige una contraseña nueva para entrar.',
              })}
            </p>
          )}
          <div>
            <label htmlFor="invite-code" className={LABEL}>
              {t('invitation.code_label', { defaultValue: 'Código' })}
            </label>
            <input
              id="invite-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className={`${INPUT} tracking-[0.3em]`}
            />
          </div>
          {!accountExists && (
            <div>
              <label htmlFor="invite-name" className={LABEL}>
                {t('invitation.code_name_label', { defaultValue: 'Tu nombre' })}
              </label>
              <input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={80}
                className={INPUT}
              />
            </div>
          )}
          <div>
            <label htmlFor="invite-password" className={LABEL}>
              {t('invitation.code_password_label', { defaultValue: 'Contraseña' })}
            </label>
            <input
              id="invite-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              maxLength={MAX_PASSWORD_BYTES}
              aria-describedby="invite-password-hint"
              className={INPUT}
            />
            <p id="invite-password-hint" className="mt-1 text-xs text-neutral-500">
              {t('invitation.code_password_hint', { defaultValue: 'Al menos 8 caracteres.' })}
            </p>
          </div>
          <div>
            <label htmlFor="invite-repeat" className={LABEL}>
              {t('invitation.code_repeat_label', { defaultValue: 'Repite la contraseña' })}
            </label>
            <input
              id="invite-repeat"
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              maxLength={MAX_PASSWORD_BYTES}
              className={INPUT}
            />
          </div>
          <button type="submit" disabled={submitting} className={PRIMARY}>
            {submitting
              ? t('invitation.code_submitting', { defaultValue: 'Entrando…' })
              : t('invitation.code_submit', { defaultValue: 'Crear cuenta y entrar' })}
          </button>
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={sending || submitting || wait > 0}
            className="w-full py-1 text-sm text-neutral-400 transition-colors hover:text-white disabled:opacity-50 disabled:hover:text-neutral-400"
          >
            {wait > 0
              ? t('invitation.code_resend_in', { defaultValue: 'Enviar otro código ({{wait}})', wait: waitLabel(wait) })
              : t('invitation.code_resend', { defaultValue: 'Enviar otro código' })}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" aria-live="assertive" className="text-red-400">
          {error}
        </p>
      )}
      {info && (
        <p role="status" aria-live="polite" className="text-neutral-400">
          {info}
        </p>
      )}
      {notice && (
        <p role="status" aria-live="polite" className="text-neutral-300">
          {notice}{' '}
          <a href="/login" className="text-primary-400 hover:text-primary-300">
            {t('invitation.code_go_login', { defaultValue: 'Ir a iniciar sesión' })}
          </a>
        </p>
      )}
    </div>
  );
}
