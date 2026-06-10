'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useTranslation } from '@tricigo/i18n';
import { getSupabaseClient, referralService, walletService } from '@tricigo/api';
import type { Referral } from '@tricigo/types';

const STATUS_BADGE: Record<Referral['status'], { bg: string; color: string; key: string; defaultLabel: string }> = {
  pending: {
    bg: '#FEF3C7', color: '#92400E',
    key: 'web.referral_status_pending',
    defaultLabel: 'Pendiente',
  },
  rewarded: {
    bg: '#DCFCE7', color: '#166534',
    key: 'web.referral_status_rewarded',
    defaultLabel: 'Recompensado',
  },
  invalidated: {
    bg: '#FEE2E2', color: '#991B1B',
    key: 'web.referral_status_invalidated',
    defaultLabel: 'Invalidado',
  },
};

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CU', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'America/Havana',
  });
}

export default function ReferralPage() {
  const { t } = useTranslation('web');
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Referral state — sourced from referralService so the format
  // matches what applyReferralCode() validates against. Earlier
  // versions hardcoded `TRICI${userId.slice(0,6)}` which is NOT
  // recognized by the backend (it ilike-matches user.id prefix
  // without the TRICI prefix), so any link the web ever shared was
  // unusable. Switching to the service unifies with mobile.
  const [myCode, setMyCode] = useState('');
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [hasBeenReferred, setHasBeenReferred] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  // PASS #3 REFERRAL-HARDCODE: bonus is admin-configurable
  // (platform_config.referral_bonus_cup, mig 00395). Default 500 until fetched.
  const [bonusCup, setBonusCup] = useState(500);

  // Apply-a-code form state.
  const [inputCode, setInputCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const [copied, setCopied] = useState(false);

  // ── Auth boot ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load code + history when user known ──
  const loadData = useCallback(async (uid: string) => {
    setDataLoading(true);
    setDataError(null);
    try {
      const [code, history, referred, bonusRaw] = await Promise.all([
        referralService.getOrCreateReferralCode(uid),
        referralService.getReferralHistory(uid),
        referralService.hasBeenReferred(uid),
        walletService.getConfigValue('referral_bonus_cup').catch(() => null),
      ]);
      setMyCode(code);
      setReferrals(history);
      setHasBeenReferred(referred);
      const parsedBonus = bonusRaw != null ? parseInt(bonusRaw, 10) : NaN;
      if (Number.isFinite(parsedBonus) && parsedBonus > 0) setBonusCup(parsedBonus);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : String(err));
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId) loadData(userId);
  }, [userId, loadData]);

  const shareLink = myCode ? `https://tricigo.com/refer/${myCode}` : '';

  const stats = {
    totalSent: referrals.length,
    rewarded: referrals.filter((r) => r.status === 'rewarded').length,
    earnedCup: referrals
      .filter((r) => r.status === 'rewarded')
      .reduce((sum, r) => sum + r.bonus_amount, 0),
  };

  const handleCopy = async () => {
    if (!myCode) return;
    try {
      await navigator.clipboard.writeText(myCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const input = document.createElement('input');
      input.value = myCode;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleNativeShare = async () => {
    if (!myCode || !shareLink) return;
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({
          title: t('web.referral_share_title', { defaultValue: 'TriciGo — invitación' }),
          text: t('web.referral_share_text', {
            defaultValue: 'Usá mi código {{code}} y descargá TriciGo: ',
            code: myCode,
          }),
          url: shareLink,
        });
      } catch {
        // User cancelled — no-op.
      }
    } else {
      // Fallback to copy when Web Share API isn't available (desktop).
      handleCopy();
    }
  };

  const handleApply = async () => {
    if (!userId || !inputCode.trim() || submitting) return;
    setSubmitError(null);
    setSubmitSuccess(false);
    setSubmitting(true);
    try {
      await referralService.applyReferralCode(userId, inputCode.trim());
      setSubmitSuccess(true);
      setInputCode('');
      // Reload state so the "you've been referred" message appears
      // and the input is hidden.
      await loadData(userId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ──

  if (authLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <p style={{ color: 'var(--text-tertiary)' }}>{t('web.loading', { defaultValue: 'Cargando...' })}</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '1rem' }}>
        <p style={{ color: 'var(--text-secondary)' }}>
          {t('web.referral_login_required', { defaultValue: 'Iniciá sesión para ver tu código de referido' })}
        </p>
        <Link href="/login" style={{ color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
          {t('web.login', { defaultValue: 'Iniciar sesión' })}
        </Link>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem', background: 'var(--bg-card)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '2rem' }}>
        <Link href="/profile" aria-label={t('web.back', { defaultValue: 'Volver' })}
          style={{ color: 'var(--text-primary)', textDecoration: 'none', marginRight: '1rem' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
          {t('web.referral_title', { defaultValue: 'Programa de referidos' })}
        </h1>
      </div>

      {/* Promo Banner — copy honest: only the referrer earns */}
      <div style={{
        background: 'linear-gradient(135deg, var(--primary), #FB923C)',
        borderRadius: '1rem',
        padding: '2rem 1.5rem',
        color: '#fff',
        textAlign: 'center',
        marginBottom: '1.5rem',
      }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
            <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
          </svg>
        </div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem' }}>
          {t('web.referral_banner_title', { defaultValue: 'Invitá amigos y ganá TriciCoins' })}
        </h2>
        <p style={{ fontSize: '0.9rem', opacity: 0.95, margin: 0, lineHeight: 1.5 }}>
          {t('web.referral_banner_desc', {
            defaultValue: 'Compartí tu código. Cuando tu amigo complete su primer viaje, recibís {{bonus}} CUP en TriciCoins.',
            bonus: bonusCup,
          })}
        </p>
      </div>

      {/* Stats card — only when user has at least one referral */}
      {!dataLoading && referrals.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '0.75rem',
          marginBottom: '1.5rem',
        }}>
          <StatBox label={t('web.referral_stat_invited', { defaultValue: 'Invitados' })} value={String(stats.totalSent)} />
          <StatBox label={t('web.referral_stat_rewarded', { defaultValue: 'Premiados' })} value={String(stats.rewarded)} />
          <StatBox label={t('web.referral_stat_earned', { defaultValue: 'Ganaste' })} value={`${stats.earnedCup} CUP`} accent />
        </div>
      )}

      {/* Referral Code */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.referral_your_code', { defaultValue: 'Tu código de referido' })}
        </h2>
        <div style={{
          background: 'var(--bg-page)',
          borderRadius: '0.75rem',
          padding: '1.25rem',
          textAlign: 'center',
          border: '2px dashed var(--border)',
        }}>
          {dataLoading ? (
            <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>—</p>
          ) : (
            <p style={{
              fontSize: '1.75rem',
              fontWeight: 800,
              letterSpacing: '0.15em',
              color: 'var(--primary)',
              margin: 0,
              fontFamily: 'monospace',
            }}>
              {myCode || '—'}
            </p>
          )}
        </div>
      </div>

      {/* Share Link + actions */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          {t('web.referral_share_link', { defaultValue: 'Enlace para compartir' })}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{
            flex: 1,
            padding: '0.75rem 1rem',
            background: 'var(--bg-page)',
            borderRadius: '0.75rem',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {shareLink || '—'}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!myCode}
            style={{
              padding: '0.75rem 1rem',
              background: copied ? 'var(--success, #16A34A)' : 'var(--primary)',
              color: '#fff',
              border: 'none',
              borderRadius: '0.75rem',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: myCode ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              transition: 'background 0.2s',
              opacity: myCode ? 1 : 0.6,
            }}
          >
            {copied
              ? t('web.referral_copied', { defaultValue: '¡Copiado!' })
              : t('web.referral_copy', { defaultValue: 'Copiar' })}
          </button>
          {/* Web Share API — only show on browsers that support it. */}
          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <button
              type="button"
              onClick={handleNativeShare}
              disabled={!myCode}
              aria-label={t('web.referral_share_action', { defaultValue: 'Compartir' })}
              style={{
                padding: '0.75rem',
                background: 'var(--bg-page)',
                color: 'var(--primary)',
                border: '1px solid var(--border)',
                borderRadius: '0.75rem',
                cursor: myCode ? 'pointer' : 'not-allowed',
                opacity: myCode ? 1 : 0.6,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Apply a referral code — hidden once the user has accepted one */}
      {!hasBeenReferred ? (
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
            {t('web.referral_apply_title', { defaultValue: '¿Te invitaron? Aplicá un código' })}
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase().replace(/\s/g, ''))}
              placeholder={t('web.referral_apply_placeholder', { defaultValue: 'Ej. ABC12345' })}
              maxLength={20}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label={t('web.referral_apply_aria', { defaultValue: 'Código de referido' })}
              style={{
                flex: 1,
                padding: '0.75rem 1rem',
                background: 'var(--bg-page)',
                border: `1px solid ${submitError ? 'var(--error, #DC2626)' : 'var(--border)'}`,
                borderRadius: '0.75rem',
                fontSize: '0.95rem',
                fontFamily: 'monospace',
                letterSpacing: '0.08em',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={handleApply}
              disabled={!inputCode.trim() || submitting}
              style={{
                padding: '0.75rem 1.25rem',
                background: 'var(--primary)',
                color: '#fff',
                border: 'none',
                borderRadius: '0.75rem',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: !inputCode.trim() || submitting ? 'not-allowed' : 'pointer',
                opacity: !inputCode.trim() || submitting ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {submitting
                ? t('web.referral_applying', { defaultValue: 'Aplicando...' })
                : t('web.referral_apply', { defaultValue: 'Aplicar' })}
            </button>
          </div>
          {/* Inline feedback — error first, then success. */}
          {submitError && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--error, #DC2626)' }}>
              {submitError}
            </p>
          )}
          {submitSuccess && !submitError && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--success, #16A34A)' }}>
              {t('web.referral_apply_success', { defaultValue: '¡Código aplicado! El bono se acreditará a tu invitador cuando completes tu primer viaje.' })}
            </p>
          )}
        </section>
      ) : (
        <section style={{ marginBottom: '2rem' }}>
          <div style={{
            padding: '1rem 1.25rem',
            background: 'var(--bg-page)',
            border: '1px solid var(--border)',
            borderRadius: '0.75rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
          }}>
            <span style={{ fontSize: '1.25rem' }}>✓</span>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              {t('web.referral_already_applied', { defaultValue: 'Ya aceptaste un código de referido. Solo se puede usar uno por cuenta.' })}
            </p>
          </div>
        </section>
      )}

      {/* My referrals — list with status badges */}
      {!dataLoading && referrals.length > 0 && (
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
            {t('web.referral_history_title', { defaultValue: 'Mis referidos' })}
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {referrals.map((r) => {
              const badge = STATUS_BADGE[r.status];
              return (
                <li key={r.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.75rem 1rem',
                  background: 'var(--bg-page)',
                  borderRadius: '0.75rem',
                  border: '1px solid var(--border)',
                  gap: '0.75rem',
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{
                      margin: 0,
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                    }}>
                      {r.code}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                      {formatShortDate(r.created_at)}
                      {r.status === 'rewarded' && r.rewarded_at && (
                        <> · {t('web.referral_rewarded_on', { defaultValue: 'Premiado' })} {formatShortDate(r.rewarded_at)}</>
                      )}
                    </p>
                  </div>
                  <span style={{
                    padding: '0.25rem 0.65rem',
                    background: badge.bg,
                    color: badge.color,
                    borderRadius: '999px',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}>
                    {t(badge.key, { defaultValue: badge.defaultLabel })}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {dataError && (
        <p style={{ color: 'var(--error, #DC2626)', fontSize: '0.85rem', textAlign: 'center', marginBottom: '1rem' }}>
          {dataError}
        </p>
      )}

      {/* How it works */}
      <div style={{
        background: 'var(--bg-card)',
        borderRadius: '1rem',
        border: '1px solid var(--border-light, var(--border))',
        padding: '1.5rem',
      }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 1rem', color: 'var(--text-primary)' }}>
          {t('web.referral_how_title', { defaultValue: 'Cómo funciona' })}
        </h2>
        {[
          { num: '1', text: t('web.referral_step_1', { defaultValue: 'Compartí tu código o enlace con un amigo.' }) },
          { num: '2', text: t('web.referral_step_2', { defaultValue: 'Tu amigo se registra usando tu código y completa su primer viaje.' }) },
          { num: '3', text: t('web.referral_step_3', {
            defaultValue: 'Recibís {{bonus}} CUP en TriciCoins, acreditados directamente a tus créditos de viaje.',
            bonus: bonusCup,
          }) },
        ].map((step, i, arr) => (
          <div key={step.num} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '1rem',
            marginBottom: i === arr.length - 1 ? 0 : '1rem',
          }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--primary)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '0.85rem',
              flexShrink: 0,
            }}>
              {step.num}
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step.text}</p>
          </div>
        ))}
      </div>
    </main>
  );
}

function StatBox({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      padding: '0.85rem 0.5rem',
      background: 'var(--bg-page)',
      border: '1px solid var(--border)',
      borderRadius: '0.75rem',
      textAlign: 'center',
    }}>
      <p style={{
        margin: 0,
        fontSize: '1.25rem',
        fontWeight: 700,
        color: accent ? 'var(--primary)' : 'var(--text-primary)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </p>
      <p style={{ margin: '2px 0 0', fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </p>
    </div>
  );
}
