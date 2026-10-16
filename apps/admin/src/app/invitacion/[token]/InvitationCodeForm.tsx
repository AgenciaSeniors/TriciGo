'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
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
/** Answers that mean the invitation itself is over: Google cannot accept it either. */
const INVITATION_OVER = new Set(['expired', 'canceled', 'used', 'not_found']);
/** Answers after which this invitation cannot be accepted with a code at all: the form closes. */
const FORM_CLOSED = new Set([...INVITATION_OVER, 'blocked', 'needs_google', 'internal_address']);

type Field = 'code' | 'name' | 'password' | 'repeat';

/** The field a server answer is about, so it can be marked as invalid. */
const ANSWER_FIELD: Partial<Record<string, Field>> = {
  wrong_code: 'code',
  weak_password: 'password',
  bad_password: 'password',
  bad_name: 'name',
};

const ERROR_ID = 'invite-code-error';

const INPUT =
  'w-full px-4 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-primary-500 text-sm';
const PRIMARY =
  'w-full py-2.5 bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors';
const SECONDARY =
  'w-full py-1 text-sm text-neutral-400 transition-colors hover:text-white disabled:opacity-50 disabled:hover:text-neutral-400';
const LABEL = 'block text-sm font-medium text-neutral-300 mb-1';
const LINK = 'text-primary-400 hover:text-primary-300';

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

/**
 * A wait for the button label: "45 s", "3 min" or "2 h" (same units in es/en/pt). Minutes are
 * rounded first and turn into hours at 60, like waitPhrase in @tricigo/utils/teamInvitation,
 * so it never reads "60 min".
 */
function waitLabel(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

interface InvitationCodeFormProps {
  token: string;
  emailMasked: string;
  /** The invitation was accepted here, or it is over (expired, canceled, used, not found): the page hides Google. */
  onSettled?: () => void;
}

/**
 * The second way to accept an invitation (00664): a code sent to the invited address and a
 * password. On success it signs in with that password and goes to the person's panel home.
 */
export function InvitationCodeForm({ token, emailMasked, onSettled }: InvitationCodeFormProps) {
  const { t } = useTranslation('admin');
  const router = useRouter();
  const sendRef = useRef<HTMLButtonElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** The form for the code is showing (a code went out, or the person already has one). */
  const [sent, setSent] = useState(false);
  /** This page knows a code went out just now: it can say when it expires. */
  const [sentHere, setSentHere] = useState(false);
  /** Whether the invited address already has an account; null when no send told us. */
  const [accountExists, setAccountExists] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** The invitation was accepted: the code is spent and the form goes away. */
  const [done, setDone] = useState(false);
  /** The answer that closed the form (expired, used, needs Google…); null while it is open. */
  const [closedBy, setClosedBy] = useState<string | null>(null);
  /** When a code can be asked for again (epoch ms), and the clock the countdown reads. */
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<Field | null>(null);
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

  // The next thing to do gets the focus: "Enviar código" when the option opens, the code field
  // when the form for it shows.
  useEffect(() => {
    if (!open) return;
    (sent ? codeRef.current : sendRef.current)?.focus();
  }, [open, sent]);

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  /** Keeps the send buttons off for at least this long (a longer wait already set wins). */
  const holdSending = (seconds: number) => {
    const current = Date.now();
    setNow(current);
    setResendAt((previous) => Math.max(previous, current + seconds * 1000));
  };

  const clearMessages = () => {
    setError('');
    setErrorField(null);
    setInfo('');
  };

  const fail = (message: string, field: Field | null = null) => {
    setError(message);
    setErrorField(field);
  };

  const closeIfFinal = (result: string | null) => {
    if (!result || !FORM_CLOSED.has(result)) return;
    setClosedBy(result);
    if (INVITATION_OVER.has(result)) onSettled?.();
  };

  /** aria-describedby for a field: its own hint, plus the error line when the error is about it. */
  const describedBy = (field: Field, hint?: string) =>
    [hint, errorField === field ? ERROR_ID : null].filter(Boolean).join(' ') || undefined;

  const generic = () => t('invitation.code_error', { defaultValue: 'Algo salió mal. Intenta de nuevo.' });

  const sendCode = async () => {
    const again = sent;
    setSending(true);
    clearMessages();
    try {
      const res = await teamService.requestInvitationCode(token);
      setAccountExists(res.accountExists);
      if (res.inviteeName) setName((current) => current || res.inviteeName);
      setCode('');
      setSentHere(true);
      setSent(true);
      holdSending(RESEND_AFTER_S);
      if (again) {
        setInfo(
          t('invitation.code_resent', { defaultValue: 'Te mandamos un código nuevo. El anterior ya no sirve.' }),
        );
        codeRef.current?.focus();
      }
    } catch (err) {
      const failure = readFailure(err, generic());
      if (failure.retryAfterS) holdSending(failure.retryAfterS);
      if (!again && failure.result === 'cooldown') {
        // A code went out under a minute ago (a reload, another tab): it still works, so the
        // form opens for it. Whether the address has an account stays unknown.
        setAccountExists(null);
        setSentHere(true);
        setSent(true);
        setInfo(failure.message);
        return;
      }
      fail(failure.message);
      if (again && failure.result === 'send_failed') {
        // The server already replaced the code: the one typed is gone, and so is the cooldown.
        setCode('');
        holdSending(RESEND_AFTER_S);
      }
      closeIfFinal(failure.result);
    } finally {
      setSending(false);
    }
  };

  /** The person already holds a code (page reloaded, link reopened): the form opens without sending. */
  const haveCode = () => {
    clearMessages();
    setAccountExists(null);
    setSentHere(false);
    setSent(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || sending || done) return;
    clearMessages();
    // Every space goes, as on the server: a pasted "048 213" is a valid code.
    const cleanCode = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) {
      fail(t('invitation.code_missing', { defaultValue: 'Escribe el código de 6 dígitos.' }), 'code');
      return;
    }
    if (accountExists === false && !name.trim()) {
      fail(t('invitation.code_name_missing', { defaultValue: 'Escribe tu nombre.' }), 'name');
      return;
    }
    if (password.length < 8) {
      fail(t('invitation.code_too_short', { defaultValue: 'La contraseña tiene que tener al menos 8 caracteres.' }), 'password');
      return;
    }
    if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
      fail(t('invitation.code_too_long', { defaultValue: 'La contraseña es demasiado larga.' }), 'password');
      return;
    }
    if (password !== repeat) {
      fail(t('invitation.code_mismatch', { defaultValue: 'Las contraseñas no coinciden.' }), 'repeat');
      return;
    }

    setSubmitting(true);
    let accepted: InvitationCodeAccepted;
    try {
      accepted = await teamService.acceptInvitationWithCode({
        token,
        code: cleanCode,
        password,
        // The server ignores it for an existing account and uses the invitation's name when empty.
        fullName: accountExists === true ? null : name.trim() || null,
      });
    } catch (err) {
      const failure = readFailure(err, generic());
      fail(failure.message, failure.result ? (ANSWER_FIELD[failure.result] ?? null) : null);
      if (failure.result && CODE_GONE.has(failure.result)) setCode('');
      if (failure.result === 'weak_password') {
        setPassword('');
        setRepeat('');
      }
      closeIfFinal(failure.result);
      setSubmitting(false);
      return;
    }

    // From here the account exists and the invitation is accepted, whatever the sign-in does.
    setDone(true);
    onSettled?.();
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
    // The password did its job: it does not stay in the page's memory.
    setPassword('');
    setRepeat('');
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
    // replace: Back must not return to an invitation that is already used. Same pair as /login.
    router.replace(panelHome(accepted.role));
    router.refresh();
  };

  const loginLink = (
    <a href="/login" className={LINK}>
      {t('invitation.code_go_login', { defaultValue: 'Ir a iniciar sesión' })}
    </a>
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-neutral-700 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
      >
        {t('invitation.code_option', { defaultValue: 'Entrar con un código por correo' })}
      </button>
    );
  }

  return (
    <div className="space-y-3 border-t border-neutral-800 pt-4">
      {closedBy ? null : done ? (
        !notice && (
          <p role="status" aria-live="polite">
            {t('invitation.code_submitting', { defaultValue: 'Entrando…' })}
          </p>
        )
      ) : !sent ? (
        <>
          <p>
            {t('invitation.code_intro', {
              defaultValue: 'Te vamos a mandar un código de 6 dígitos a {{email}}.',
              email: emailMasked,
            })}
          </p>
          <button
            ref={sendRef}
            type="button"
            onClick={() => void sendCode()}
            disabled={sending || wait > 0}
            className={PRIMARY}
          >
            {sending
              ? t('invitation.code_sending', { defaultValue: 'Enviando…' })
              : wait > 0
                ? t('invitation.code_send_in', { defaultValue: 'Enviar código ({{wait}})', wait: waitLabel(wait) })
                : t('invitation.code_send', { defaultValue: 'Enviar código' })}
          </button>
          <button type="button" onClick={haveCode} disabled={sending} className={SECONDARY}>
            {t('invitation.code_have_one', { defaultValue: 'Ya tengo un código' })}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <p>
            {sentHere
              ? t('invitation.code_sent', {
                  defaultValue: 'Te mandamos el código a {{email}}. Vence en 10 minutos.',
                  email: emailMasked,
                })
              : t('invitation.code_have_one_intro', {
                  defaultValue: 'Escribe el código que te mandamos a {{email}}.',
                  email: emailMasked,
                })}
          </p>
          {accountExists === true && (
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
              ref={codeRef}
              id="invite-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-invalid={errorField === 'code' || undefined}
              aria-describedby={describedBy('code')}
              className={`${INPUT} tracking-[0.3em]`}
            />
          </div>
          {accountExists !== true && (
            <div>
              <label htmlFor="invite-name" className={LABEL}>
                {accountExists === null
                  ? t('invitation.code_name_optional', { defaultValue: 'Tu nombre (si todavía no tienes cuenta)' })
                  : t('invitation.code_name_label', { defaultValue: 'Tu nombre' })}
              </label>
              <input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={80}
                aria-invalid={errorField === 'name' || undefined}
                aria-describedby={describedBy('name')}
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
              aria-invalid={errorField === 'password' || undefined}
              aria-describedby={describedBy('password', 'invite-password-hint')}
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
              aria-invalid={errorField === 'repeat' || undefined}
              aria-describedby={describedBy('repeat')}
              className={INPUT}
            />
          </div>
          <button type="submit" disabled={submitting || sending} className={PRIMARY}>
            {submitting
              ? t('invitation.code_submitting', { defaultValue: 'Entrando…' })
              : accountExists === false
                ? t('invitation.code_submit', { defaultValue: 'Crear cuenta y entrar' })
                : t('invitation.code_submit_existing', { defaultValue: 'Entrar al panel' })}
          </button>
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={sending || submitting || wait > 0}
            className={SECONDARY}
          >
            {wait > 0
              ? t('invitation.code_resend_in', { defaultValue: 'Enviar otro código ({{wait}})', wait: waitLabel(wait) })
              : t('invitation.code_resend', { defaultValue: 'Enviar otro código' })}
          </button>
        </form>
      )}
      {error && (
        <p id={ERROR_ID} role="alert" aria-live="assertive" className="text-red-400">
          {error}
          {closedBy === 'used' && <> {loginLink}</>}
        </p>
      )}
      {info && (
        <p role="status" aria-live="polite" className="text-neutral-400">
          {info}
        </p>
      )}
      {notice && (
        <p role="status" aria-live="polite" className="text-neutral-300">
          {notice} {loginLink}
        </p>
      )}
    </div>
  );
}
