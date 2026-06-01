'use client';

/**
 * Send gift (web) — parity con apps/client/app/wallet/gift.tsx. Closed-loop
 * TriciCoin gift: look up an active user by gift code or phone, then send.
 * Recipient lookup + anti-self guard + amount validation mirror the native
 * screen; the server `send_gift` RPC enforces the rest. QR camera scan is
 * native-only — web uses the code text + copy/share (same fallback the
 * client uses on web).
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { walletService, referralService } from '@tricigo/api';
import { formatTRC, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../../providers';

type LookupMode = 'code' | 'phone';
type Recipient = { id: string; full_name: string };

export default function GiftPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation('common');
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();

  const [balance, setBalance] = useState(0);
  const [myCode, setMyCode] = useState('');
  const [mode, setMode] = useState<LookupMode>('code');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.replace('/login');
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!user?.id) return;
    Promise.all([
      walletService.getBalance(user.id, 'customer_cash'),
      referralService.getOrCreateReferralCode(user.id).catch(() => ''),
    ]).then(([bal, code]) => {
      setBalance(bal.available);
      setMyCode(code);
    }).catch(() => { /* non-critical */ });
  }, [user?.id]);

  const applyFound = useCallback((found: Recipient | null) => {
    if (!found) { setFeedback({ kind: 'error', text: t('gift.recipient_not_found', { defaultValue: 'Usuario no encontrado' }) }); return; }
    if (found.id === user?.id) { setFeedback({ kind: 'error', text: t('gift.cannot_self', { defaultValue: 'No puedes regalarte a ti mismo' }) }); return; }
    setRecipient({ id: found.id, full_name: found.full_name });
    setFeedback(null);
  }, [user?.id, t]);

  const resolveByCode = useCallback(async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setSearching(true);
    setRecipient(null);
    try {
      applyFound(await walletService.findUserByGiftCode(c));
    } catch (err) {
      setFeedback({ kind: 'error', text: getErrorMessage(err) });
    } finally {
      setSearching(false);
    }
  }, [applyFound]);

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    if (mode === 'code') { void resolveByCode(q); return; }
    setSearching(true);
    setRecipient(null);
    try {
      applyFound(await walletService.findUserByPhone(q));
    } catch (err) {
      setFeedback({ kind: 'error', text: getErrorMessage(err) });
    } finally {
      setSearching(false);
    }
  }

  // Deep link: /gift/<code> redirects here with ?code=, auto-resolving.
  useEffect(() => {
    const codeParam = searchParams.get('code');
    if (codeParam) {
      setMode('code');
      setQuery(codeParam);
      void resolveByCode(codeParam);
    }
  }, [searchParams, resolveByCode]);

  const numericAmount = parseInt(amount, 10);
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0 && numericAmount <= balance;

  async function handleSend() {
    if (!user?.id || !recipient || !amountValid) return;
    setSubmitting(true);
    try {
      await walletService.sendGift(user.id, recipient.id, numericAmount, note.trim() || undefined);
      setFeedback({ kind: 'success', text: t('gift.success_msg', { defaultValue: `Le enviaste ${formatTRC(numericAmount)} a ${recipient.full_name}` }) });
      setRecipient(null);
      setAmount('');
      setNote('');
      setQuery('');
      // Refresh balance.
      walletService.getBalance(user.id, 'customer_cash').then((b) => setBalance(b.available)).catch(() => {});
    } catch (err) {
      setFeedback({ kind: 'error', text: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyCode() {
    if (!myCode) return;
    try {
      await navigator.clipboard.writeText(myCode);
      setFeedback({ kind: 'success', text: t('copied', { defaultValue: 'Copiado' }) });
    } catch {
      void handleShareCode();
    }
  }

  async function handleShareCode() {
    if (!myCode) return;
    const message = t('gift.share_code_message', { defaultValue: `Envíame un regalo en TriciGo con mi código: ${myCode}` });
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ text: message });
      } else {
        await navigator.clipboard.writeText(message);
        setFeedback({ kind: 'success', text: t('copied', { defaultValue: 'Copiado' }) });
      }
    } catch { /* user cancelled */ }
  }

  const card: React.CSSProperties = { padding: '1rem', borderRadius: '0.85rem', border: '1px solid var(--border)', background: 'var(--bg-card)' };

  return (
    <main className="page-main">
      <div className="page-container" style={{ maxWidth: 520 }}>
        <Link href="/wallet" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>&larr; {t('back', { defaultValue: 'Volver' })}</Link>
        <h1 style={{ fontSize: 'clamp(1.4rem,4vw,1.9rem)', fontWeight: 800, margin: '1rem 0 1rem' }}>
          {t('gift.title', { defaultValue: 'Enviar regalo' })}
        </h1>

        {feedback && (
          <p style={{ fontSize: '0.85rem', marginBottom: '0.75rem', color: feedback.kind === 'error' ? 'var(--error, #dc2626)' : '#16a34a' }}>{feedback.text}</p>
        )}

        {/* Balance */}
        <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', background: 'rgba(255,77,0,0.06)' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('gift.your_balance', { defaultValue: 'Tu saldo' })}</span>
          <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--primary)' }}>{formatTRC(balance)}</span>
        </div>

        {/* Recipient lookup */}
        {!recipient ? (
          <div style={{ ...card, marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.75rem' }}>{t('gift.find_recipient', { defaultValue: '¿A quién le regalas?' })}</div>
            <div style={{ display: 'flex', marginBottom: '0.75rem' }}>
              {(['code', 'phone'] as LookupMode[]).map((m) => (
                <button key={m} type="button" onClick={() => { setMode(m); setQuery(''); }}
                  style={{ flex: 1, padding: '0.5rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border)',
                    borderRadius: m === 'code' ? '0.5rem 0 0 0.5rem' : '0 0.5rem 0.5rem 0',
                    background: mode === m ? 'var(--primary)' : 'var(--bg-page)', color: mode === m ? '#fff' : 'var(--text-secondary)' }}>
                  {m === 'code' ? t('gift.by_code', { defaultValue: 'Código' }) : t('gift.by_phone', { defaultValue: 'Teléfono' })}
                </button>
              ))}
            </div>
            <input
              type={mode === 'phone' ? 'tel' : 'text'}
              value={query}
              onChange={(e) => setQuery(mode === 'code' ? e.target.value.toUpperCase() : e.target.value)}
              placeholder={mode === 'code' ? t('gift.code_placeholder', { defaultValue: 'Código del amigo' }) : '+53XXXXXXXX'}
              className="input-base"
              style={{ width: '100%' }}
            />
            <button type="button" onClick={handleSearch} disabled={!query.trim() || searching}
              style={{ width: '100%', marginTop: '0.6rem', padding: '0.7rem', borderRadius: '0.6rem', border: '1px solid var(--primary)', background: 'var(--bg-page)', color: 'var(--primary)', fontWeight: 600, cursor: !query.trim() || searching ? 'not-allowed' : 'pointer', opacity: !query.trim() || searching ? 0.6 : 1 }}>
              {searching ? t('gift.searching', { defaultValue: 'Buscando…' }) : t('gift.search', { defaultValue: 'Buscar' })}
            </button>
          </div>
        ) : (
          <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>{t('gift.sending_to', { defaultValue: 'Le regalas a' })}</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>{recipient.full_name}</div>
            </div>
            <button type="button" onClick={() => { setRecipient(null); setQuery(''); }} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.85rem' }}>
              {t('gift.change', { defaultValue: 'Cambiar' })}
            </button>
          </div>
        )}

        {/* Amount + note */}
        {recipient && (
          <div style={{ ...card, marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem' }}>{t('gift.amount', { defaultValue: 'Monto del regalo' })}</div>
            <input
              type="text"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="0"
              className="input-base"
              style={{ width: '100%' }}
            />
            {amount.length > 0 && !amountValid && (
              <p style={{ fontSize: '0.72rem', color: 'var(--error, #dc2626)', margin: '0.25rem 0 0' }}>
                {numericAmount > balance ? t('gift.insufficient', { defaultValue: 'Saldo insuficiente' }) : t('gift.invalid_amount', { defaultValue: 'Monto inválido' })}
              </p>
            )}
            <div style={{ fontSize: '0.95rem', fontWeight: 600, margin: '1rem 0 0.5rem' }}>{t('gift.message_optional', { defaultValue: 'Mensaje (opcional)' })}</div>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="¡Feliz cumple!" className="input-base" style={{ width: '100%' }} />
            <button type="button" onClick={handleSend} disabled={!amountValid || submitting}
              style={{ width: '100%', marginTop: '1rem', padding: '0.85rem', borderRadius: '0.7rem', border: 'none', color: '#fff', fontWeight: 700, cursor: !amountValid || submitting ? 'not-allowed' : 'pointer', background: !amountValid || submitting ? '#ccc' : 'var(--primary)' }}>
              {submitting ? t('gift.sending', { defaultValue: 'Enviando…' }) : t('gift.send', { defaultValue: 'Enviar regalo' })}
            </button>
          </div>
        )}

        {/* My code to receive */}
        <div style={{ ...card, textAlign: 'center', background: 'rgba(255,77,0,0.06)' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('gift.my_code', { defaultValue: 'Tu código para recibir regalos' })}</div>
          <button type="button" onClick={handleCopyCode} disabled={!myCode}
            style={{ background: 'none', border: 'none', cursor: myCode ? 'pointer' : 'default', fontSize: '1.6rem', fontWeight: 800, color: 'var(--primary)', letterSpacing: '0.15em' }}>
            {myCode || '…'} {myCode ? '⧉' : ''}
          </button>
          {/* QR escaneable del código — un amigo lo escanea con la cámara del
              teléfono y abre /gift/<code> (landing → pantalla de regalo precargada).
              Parity con el QR nativo, que en el client sólo existe en mobile. */}
          {myCode ? (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '0.75rem 0' }}>
              <div style={{ padding: 12, background: '#fff', borderRadius: 12, lineHeight: 0 }}>
                <QRCodeSVG value={`https://tricigo.com/gift/${myCode}`} size={150} />
              </div>
            </div>
          ) : null}
          <div>
            <button type="button" onClick={handleShareCode} disabled={!myCode}
              style={{ marginTop: '0.75rem', padding: '0.55rem 1rem', borderRadius: '0.6rem', border: '1px solid var(--primary)', background: 'var(--bg-page)', color: 'var(--primary)', fontWeight: 600, cursor: myCode ? 'pointer' : 'not-allowed', opacity: myCode ? 1 : 0.6 }}>
              {t('gift.share_my_code', { defaultValue: 'Compartir mi código' })}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
