'use client';

// Page behind "Dejar de recibir este resumen" in the team daily digest (00656). The e-mail link
// carries u (account id) and t (its signed token) in the URL fragment (#u=…&t=…), which browsers
// never send to the server, so they stay out of access logs. Nothing changes on load: mail scanners
// and link previews open links by themselves, so only the buttons POST to the
// team-digest-unsubscribe Edge Function, which checks the token and records the choice. The token
// is never logged or sent anywhere but that function, and the fragment is cleared from the address
// bar right after it is read, so errors reported later from this page, later history entries and
// links followed from it don't carry it.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getSupabaseClient } from '@tricigo/api';

type Action = 'out' | 'in';
type ErrorReason = 'bad_link' | 'not_found' | 'rate_limited' | 'network' | 'server';
type View =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: Action }
  | { kind: 'error'; reason: ErrorReason; retry: Action | null; retryAfterMin: number | null };

interface DigestLink {
  u: string;
  t: string;
}

/** What the Edge Function answers: { ok, subscribed } on success, { error } otherwise. */
interface UnsubscribeResponse {
  ok?: boolean;
  subscribed?: boolean;
  error?: string;
  retryAfterSec?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const SUPPORT_EMAIL = 'soporte@tricigo.com';

function errorView(reason: ErrorReason, retry: Action | null = null, retryAfterMin: number | null = null): View {
  return { kind: 'error', reason, retry, retryAfterMin };
}

/** Maps a failed call (status + JSON body, when there is one) to what the page explains. */
function failureView(status: number | null, body: UnsubscribeResponse | null, action: Action): View {
  const code = body?.error;
  if (code === 'bad_request' || code === 'bad_link' || status === 400 || status === 403) return errorView('bad_link');
  if (code === 'not_found' || status === 404) return errorView('not_found');
  if (status === 429) {
    const sec = typeof body?.retryAfterSec === 'number' && body.retryAfterSec > 0 ? body.retryAfterSec : null;
    return errorView('rate_limited', action, sec === null ? null : Math.ceil(sec / 60));
  }
  return errorView('server', action);
}

/** supabase-js puts the raw Response of a non-2xx answer on `error.context`. */
async function readFailure(err: unknown): Promise<{ status: number | null; body: UnsubscribeResponse | null }> {
  const ctx = (err as { context?: unknown } | null)?.context;
  if (!(ctx instanceof Response)) return { status: null, body: null };
  try {
    return { status: ctx.status, body: (await ctx.json()) as UnsubscribeResponse };
  } catch {
    return { status: ctx.status, body: null };
  }
}

/**
 * Clears the fragment from the address bar and from the history entry. On load the App Router
 * copies the full URL, fragment included, into the internal tree it keeps in history.state, so the
 * entry is first rewritten with that tree cleaned (state with __NA goes straight to the browser),
 * then replaced with state null, which goes through the router: it adopts the clean URL and tree,
 * and a later re-render of the router does not write the fragment back.
 */
function forgetFragment(hash: string) {
  const url = window.location.pathname + window.location.search;
  try {
    const state: unknown = window.history.state;
    if (state && typeof state === 'object' && (state as { __NA?: unknown }).__NA) {
      window.history.replaceState(JSON.parse(JSON.stringify(state).split(hash).join('')), '', url);
    }
  } catch {
    // An entry that cannot be copied keeps its state; the address bar is still cleaned below.
  }
  window.history.replaceState(null, '', url);
}

export default function TeamDigestUnsubscribePage() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState<Action | null>(null);
  const linkRef = useRef<DigestLink | null>(null);
  const readRef = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in development: read the fragment and schedule its clearing once.
    if (readRef.current) return;
    readRef.current = true;

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const u = params.get('u') ?? '';
    const t = params.get('t') ?? '';
    if (window.location.hash) {
      // Deferred one tick: the App Router installs its history patch in an effect of its own, which
      // runs after this one. No cleanup on purpose: StrictMode's simulated unmount would cancel it
      // and the guarded second run would never schedule it again.
      const path = window.location.pathname;
      const hash = window.location.hash;
      setTimeout(() => {
        if (window.location.pathname === path) forgetFragment(hash);
      }, 0);
    }
    if (UUID_RE.test(u) && TOKEN_RE.test(t)) {
      linkRef.current = { u, t };
      setView({ kind: 'ready' });
    } else {
      setView(errorView('bad_link'));
    }
  }, []);

  async function submit(action: Action) {
    const link = linkRef.current;
    if (!link || busy) return;
    setBusy(action);
    try {
      const { data, error } = await getSupabaseClient().functions.invoke<UnsubscribeResponse>(
        'team-digest-unsubscribe',
        { body: { u: link.u, t: link.t, action } },
      );
      if (!error) {
        setView(data?.ok === true ? { kind: action } : errorView('server', action));
      } else if (error.name === 'FunctionsFetchError') {
        setView(errorView('network', action));
      } else {
        const { status, body } = await readFailure(error);
        setView(failureView(status, body, action));
      }
    } catch {
      setView(errorView('network', action));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main style={pageStyle}>
      <div className="card-base" style={cardStyle} aria-live="polite">
        <p style={eyebrowStyle}>Resumen diario del equipo</p>
        {view.kind === 'loading' && <Heading>Un momento…</Heading>}

        {view.kind === 'ready' && (
          <>
            <Badge tone="brand">
              <MailIcon />
            </Badge>
            <Heading>¿Quieres dejar de recibirlo?</Heading>
            <Text>
              Cada mañana a las 7:00, hora de Cuba, te llega por correo el resumen del día anterior. Si lo
              dejas de recibir, puedes volver a activarlo con el enlace de este mismo correo.
            </Text>
            <PrimaryButton busy={busy === 'out'} disabled={busy !== null} onClick={() => submit('out')}>
              Dejar de recibir este resumen
            </PrimaryButton>
          </>
        )}

        {view.kind === 'out' && (
          <>
            <Badge tone="success">
              <CheckIcon />
            </Badge>
            <Heading>Listo, ya no lo vas a recibir</Heading>
            <Text>
              No te vamos a mandar más el resumen diario. Si cambias de idea, puedes volver a activarlo ahora
              o más tarde con el enlace del correo.
            </Text>
            <SecondaryButton busy={busy === 'in'} disabled={busy !== null} onClick={() => submit('in')}>
              Volver a recibirlo
            </SecondaryButton>
          </>
        )}

        {view.kind === 'in' && (
          <>
            <Badge tone="success">
              <CheckIcon />
            </Badge>
            <Heading>Listo, lo vas a volver a recibir</Heading>
            <Text>Te llega todos los días a las 7:00, hora de Cuba, con los números del día anterior.</Text>
            <button
              type="button"
              style={textButtonStyle}
              disabled={busy !== null}
              onClick={() => submit('out')}
            >
              {busy === 'out' ? 'Guardando…' : 'Dejar de recibirlo'}
            </button>
          </>
        )}

        {view.kind === 'error' && (
          <>
            <Badge tone="warning">
              <span aria-hidden="true" style={{ fontSize: '1.5rem', fontWeight: 800, lineHeight: 1 }}>
                !
              </span>
            </Badge>
            <ErrorCopy reason={view.reason} retryAfterMin={view.retryAfterMin} />
            {view.retry !== null && (
              <PrimaryButton
                busy={busy !== null}
                disabled={busy !== null}
                onClick={() => {
                  if (view.retry) void submit(view.retry);
                }}
              >
                Intentar de nuevo
              </PrimaryButton>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ErrorCopy({ reason, retryAfterMin }: { reason: ErrorReason; retryAfterMin: number | null }) {
  const support = (
    <a href={`mailto:${SUPPORT_EMAIL}`} style={linkStyle}>
      {SUPPORT_EMAIL}
    </a>
  );
  switch (reason) {
    case 'bad_link':
      return (
        <>
          <Heading>Este enlace ya no funciona</Heading>
          <Text>
            Puede estar incompleto, mal copiado o ser de un correo viejo. Ábrelo de nuevo desde el botón
            «Dejar de recibir este resumen» del último resumen que te llegó. Si sigue sin funcionar, escríbenos
            a {support}.
          </Text>
        </>
      );
    case 'not_found':
      return (
        <>
          <Heading>No encontramos tu cuenta</Heading>
          <Text>
            La cuenta de este enlace ya no existe en TriciGo, así que no te va a llegar el resumen. Si crees que
            es un error, escríbenos a {support}.
          </Text>
        </>
      );
    case 'rate_limited':
      return (
        <>
          <Heading>Demasiados intentos</Heading>
          <Text>
            Por seguridad, esperamos un rato antes de aceptar más cambios desde esta conexión.{' '}
            {retryAfterMin === null
              ? 'Vuelve a intentarlo más tarde.'
              : retryAfterMin <= 1
                ? 'Vuelve a intentarlo en un minuto.'
                : `Vuelve a intentarlo en ${retryAfterMin} minutos.`}
          </Text>
        </>
      );
    case 'network':
      return (
        <>
          <Heading>No pudimos conectarnos</Heading>
          <Text>Revisa tu conexión a internet y vuelve a intentarlo.</Text>
        </>
      );
    case 'server':
      return (
        <>
          <Heading>No pudimos guardar tu elección</Heading>
          <Text>
            Tuvimos un problema de nuestro lado. Vuelve a intentarlo en unos minutos; si sigue pasando,
            escríbenos a {support}.
          </Text>
        </>
      );
  }
}

function Heading({ children }: { children: ReactNode }) {
  return <h1 style={headingStyle}>{children}</h1>;
}

function Text({ children }: { children: ReactNode }) {
  return <p style={textStyle}>{children}</p>;
}

interface ButtonProps {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}

function PrimaryButton({ busy, disabled, onClick, children }: ButtonProps) {
  return (
    <button type="button" className="btn-base btn-primary-solid" style={ctaStyle} disabled={disabled} onClick={onClick}>
      {busy ? 'Guardando…' : children}
    </button>
  );
}

function SecondaryButton({ busy, disabled, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      className="btn-base btn-secondary-outline"
      style={ctaStyle}
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? 'Guardando…' : children}
    </button>
  );
}

const BADGE_TONES: Record<'brand' | 'success' | 'warning', CSSProperties> = {
  brand: { background: 'var(--primary-alpha-10)', color: 'var(--primary)' },
  success: { background: 'rgba(34, 197, 94, 0.12)', color: 'var(--success)' },
  warning: { background: 'var(--warning-bg)', color: 'var(--warning-text)' },
};

function Badge({ tone, children }: { tone: keyof typeof BADGE_TONES; children: ReactNode }) {
  return <div style={{ ...badgeStyle, ...BADGE_TONES[tone] }}>{children}</div>;
}

function MailIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const pageStyle: CSSProperties = {
  minHeight: '70vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--space-2xl) var(--space-md)',
  background: 'var(--bg-page)',
};

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 440,
  padding: 'var(--space-xl) var(--space-lg)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: 'var(--shadow-card)',
  textAlign: 'center',
};

const eyebrowStyle: CSSProperties = {
  margin: '0 0 var(--space-lg)',
  fontSize: 'var(--text-xs)',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

const badgeStyle: CSSProperties = {
  width: 56,
  height: 56,
  margin: '0 auto var(--space-md)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--radius-full)',
};

const headingStyle: CSSProperties = {
  margin: '0 0 var(--space-sm)',
  fontSize: 'var(--text-2xl)',
  fontWeight: 700,
  lineHeight: 1.25,
  color: 'var(--text-primary)',
};

const textStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-md)',
  lineHeight: 1.6,
  color: 'var(--text-secondary)',
};

const ctaStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  marginTop: 'var(--space-lg)',
  padding: 'var(--space-md) var(--space-lg)',
  borderRadius: 'var(--radius-lg)',
  fontSize: 'var(--text-lg)',
};

const textButtonStyle: CSSProperties = {
  marginTop: 'var(--space-lg)',
  padding: 'var(--space-sm)',
  background: 'none',
  border: 'none',
  fontFamily: 'inherit',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-secondary)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

const linkStyle: CSSProperties = {
  color: 'var(--primary)',
  fontWeight: 600,
};
