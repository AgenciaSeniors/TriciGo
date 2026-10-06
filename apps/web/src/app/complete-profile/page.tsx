'use client';

/**
 * Complete-profile (web) — parity con apps/client/app/(auth)/complete-profile.
 * Forces a first-login user to set their full name (so drivers know who they
 * are) before entering the app. Reached from the login/callback routing and
 * the session guard in providers.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { authService, getSupabaseClient, referralService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useAuth } from '../providers';

// Mirror of LoginPage's PENDING_REFERRAL_KEY (a /refer/CODE or ?ref=CODE
// link stashed before login).
const PENDING_REFERRAL_KEY = 'tricigo_pending_referral';
// What referralService.applyInviteCode throws for a code that matches
// neither an acquisition code nor a referral code.
const INVALID_REFERRAL_CODE_MESSAGE = 'Código de referido inválido';

export default function CompleteProfilePage() {
  const router = useRouter();
  const { t } = useTranslation('common');
  const { user, isLoading, isAuthenticated, signOut } = useAuth();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  // Marketing consent — unchecked by default (product decision); never gates signup.
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  // Optional "Código de invitación": an influencer/channel code or a
  // friend's referral code (referralService.applyInviteCode decides).
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth gate.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace('/login');
  }, [isLoading, isAuthenticated, router]);

  // Prefill from a pending referral/influencer link, if login has not
  // already consumed it. Never overwrite something the user typed.
  useEffect(() => {
    let pending: string | null = null;
    try { pending = sessionStorage.getItem(PENDING_REFERRAL_KEY); } catch { return; }
    const code = pending?.trim().toUpperCase();
    if (code) setInviteCode((current) => current || code);
  }, []);

  // If the profile is already complete, don't strand the user here.
  useEffect(() => {
    if (!user?.id) return;
    authService.getUserById(user.id).then((p) => {
      if (p?.full_name) router.replace('/book');
    }).catch(() => { /* ignore */ });
  }, [user?.id, router]);

  async function handleContinue() {
    const trimmed = fullName.trim();
    if (trimmed.length < 2) {
      setError(t('profile.name_required', { defaultValue: 'Ingresa tu nombre completo' }));
      return;
    }
    let uid = user?.id;
    if (!uid) {
      const session = await getSupabaseClient().auth.getSession();
      uid = session.data.session?.user?.id;
    }
    if (!uid) { router.replace('/login'); return; }
    setSaving(true);
    setError(null);
    try {
      await authService.updateProfile(uid, {
        full_name: trimmed,
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      // Optional invite code. Only a code that does not exist keeps the user
      // here (the name is already saved, so Continue can simply run again);
      // any other failure (own code, already used, network) never blocks
      // signup.
      const code = inviteCode.trim();
      if (code) {
        try {
          await referralService.applyInviteCode(uid, code);
          try { sessionStorage.removeItem(PENDING_REFERRAL_KEY); } catch { /* ignore */ }
        } catch (err) {
          if (err instanceof Error && err.message === INVALID_REFERRAL_CODE_MESSAGE) {
            setInviteError(t('profile.invite_code_invalid', {
              defaultValue: 'Ese código no existe. Revísalo o deja el campo vacío.',
            }));
            return;
          }
          console.warn('[complete-profile] applyInviteCode failed', err);
        }
      }
      // Record the consent answer best-effort: a failure here must never
      // block signup (the user can still change it later in Settings).
      try {
        await authService.setMarketingOptIn(uid, marketingOptIn, 'signup');
      } catch (err) {
        console.warn('[complete-profile] setMarketingOptIn failed', err);
      }
      router.push('/book');
    } catch {
      setError(t('errors.generic', { defaultValue: 'Algo salió mal. Intenta de nuevo.' }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', background: 'var(--bg-page)' }}>
      <div style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--primary-alpha-10, rgba(255,77,0,0.08))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.75rem' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0 }}>
            {t('profile.complete_title', { defaultValue: 'Completa tu perfil' })}
          </h1>
          <p style={{ color: 'var(--text-tertiary)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
            {t('profile.complete_subtitle', { defaultValue: 'Necesitamos tu nombre para que los conductores sepan quién eres' })}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label htmlFor="cp-name" style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {t('profile.name', { defaultValue: 'Nombre completo' })}
            </label>
            <input
              id="cp-name"
              type="text"
              value={fullName}
              onChange={(e) => { setFullName(e.target.value); setError(null); }}
              placeholder={t('profile.name_placeholder', { defaultValue: 'Tu nombre completo' })}
              className="input-base"
              autoFocus
              style={{ width: '100%' }}
            />
            {fullName.trim().length > 0 && fullName.trim().length < 2 && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', margin: '0.25rem 0 0' }}>
                {t('profile.name_min_hint', { defaultValue: 'Necesitamos al menos 2 letras para identificarte.' })}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="cp-email" style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {t('profile.email_optional', { defaultValue: 'Email (opcional)' })}
            </label>
            <input
              id="cp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              className="input-base"
              style={{ width: '100%' }}
            />
          </div>

          <div>
            <label htmlFor="cp-invite" style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {t('profile.invite_code_label', { defaultValue: 'Código de invitación (opcional)' })}
            </label>
            <input
              id="cp-invite"
              type="text"
              value={inviteCode}
              onChange={(e) => { setInviteCode(e.target.value); setInviteError(null); }}
              placeholder={t('profile.invite_code_placeholder', { defaultValue: 'Ej.: MOTORENKO' })}
              className="input-base"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={inviteError ? true : undefined}
              aria-describedby="cp-invite-msg"
              style={{ width: '100%' }}
            />
            {inviteError ? (
              <p id="cp-invite-msg" role="alert" style={{ fontSize: '0.72rem', color: 'var(--error)', margin: '0.25rem 0 0' }}>
                {inviteError}
              </p>
            ) : (
              <p id="cp-invite-msg" style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', margin: '0.25rem 0 0' }}>
                {t('profile.invite_code_hint', { defaultValue: '¿Te lo dio un amigo o lo viste en redes? Escríbelo aquí.' })}
              </p>
            )}
          </div>

          <div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={marketingOptIn}
                onChange={(e) => setMarketingOptIn(e.target.checked)}
                style={{ marginTop: '0.2rem', flexShrink: 0 }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {t('profile.marketing_opt_in_label', { defaultValue: 'Quiero recibir novedades y promociones de TriciGo por WhatsApp, SMS y correo.' })}
              </span>
            </label>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', margin: '0.25rem 0 0', paddingLeft: '1.5rem' }}>
              {t('profile.marketing_opt_in_hint', { defaultValue: 'Puedes cambiarlo cuando quieras en Ajustes.' })}
            </p>
          </div>

          {error && <p role="alert" aria-live="assertive" style={{ color: 'var(--error)', fontSize: '0.875rem', textAlign: 'center' }}>{error}</p>}

          <button
            onClick={handleContinue}
            disabled={fullName.trim().length < 2 || saving}
            style={{
              width: '100%', padding: '0.875rem', borderRadius: 'var(--radius-md)', border: 'none',
              background: fullName.trim().length >= 2 && !saving ? 'var(--primary)' : 'var(--border)',
              color: fullName.trim().length >= 2 && !saving ? 'white' : 'var(--text-tertiary)',
              fontSize: '1rem', fontWeight: 600, fontFamily: 'inherit',
              cursor: fullName.trim().length >= 2 && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? t('auth.saving', { defaultValue: 'Guardando...' }) : t('continue', { defaultValue: 'Continuar' })}
          </button>

          {/* Escape hatch (parity con SwitchAccountFooter móvil, BUG-299b): un
              usuario que entró con la cuenta OAuth equivocada puede cerrar
              sesión sin quedar atrapado completando el perfil. */}
          <button
            type="button"
            onClick={async () => { await signOut(); router.replace('/login'); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: '0.8rem', cursor: 'pointer', marginTop: '0.25rem' }}
          >
            {t('auth.not_you_sign_out', { defaultValue: '¿No eres tú? Cerrar sesión' })}
          </button>
        </div>
      </div>
    </main>
  );
}
