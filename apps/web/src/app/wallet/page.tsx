'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { walletService, exchangeRateService, paymentService, getSupabaseClient } from '@tricigo/api';
import {
  formatTriciCoin,
  DEFAULT_EXCHANGE_RATE,
  getRelativeDay,
  formatTime,
  computeRechargeFeeUsd,
  computeRechargeChargeUsd,
  RECHARGE_LIMITS,
  translateNetopiaError,
  classifyWalletTxn,
} from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { LedgerTransaction, WalletAccount, PaymentProviderConfig } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

// Minimal `t` signature so the module-scope helpers below can take the
// translator without depending on the full i18n types.
type TFn = (key: string, options?: Record<string, unknown>) => string;

// Filter tabs for the transaction history: Recargas, Viajes, Bonos
// (promo_credit) and Ajustes (adjustment). Legacy P2P transfers still
// appear under "Todos" but no new transfers can be created. Labels are
// resolved via `t` inside the component (i18n key wallet.filter_<key>).
type FilterTab =
  | 'all'
  | 'recharge'
  | 'rides'
  | 'bonus'
  | 'adjustment';

const FILTER_TAB_KEYS: FilterTab[] = ['all', 'recharge', 'rides', 'bonus', 'adjustment'];

// Label derived from the shared classifier kind + direction (fixes received
// gifts showing "Transferencia enviada" and tips showing "Ajuste"). Credit vs
// debit and the amount come from the per-account net (classifyWalletTxn), not
// from the raw type — a gift is one `transfer_out` txn for both parties.
// `t` is passed in so this stays a module-scope helper (no `t` call at
// module load).
function webTxLabel(view: { kind: string; isCredit: boolean }, t: TFn): string {
  switch (view.kind) {
    case 'recharge': return t('wallet.tx_recharge', { defaultValue: 'Recarga' });
    case 'ride': return view.isCredit
      ? t('wallet.tx_ride_in', { defaultValue: 'Ingreso por viaje' })
      : t('wallet.tx_ride_out', { defaultValue: 'Pago de viaje' });
    case 'commission': return t('wallet.tx_commission', { defaultValue: 'Comisión' });
    case 'gift':
    case 'transfer': return view.isCredit
      ? t('wallet.tx_gift_in', { defaultValue: 'Regalo recibido' })
      : t('wallet.tx_gift_out', { defaultValue: 'Regalo enviado' });
    case 'tip': return view.isCredit
      ? t('wallet.tx_tip_in', { defaultValue: 'Propina recibida' })
      : t('wallet.tx_tip_out', { defaultValue: 'Propina enviada' });
    case 'penalty': return t('wallet.tx_penalty', { defaultValue: 'Penalización por cancelación' });
    case 'bonus': return t('wallet.tx_bonus', { defaultValue: 'Crédito promocional' });
    case 'refund': return t('wallet.tx_refund', { defaultValue: 'Reembolso' });
    case 'insurance': return t('wallet.tx_insurance', { defaultValue: 'Seguro de viaje' });
    case 'fx': return t('wallet.tx_fx', { defaultValue: 'Ajuste por tipo de cambio' });
    case 'adjustment':
    default: return t('wallet.tx_adjustment', { defaultValue: 'Ajuste' });
  }
}

// Label for a filter tab (i18n). Module-scope helper takes `t`.
function filterTabLabel(key: FilterTab, t: TFn): string {
  switch (key) {
    case 'recharge': return t('wallet.filter_recharge', { defaultValue: 'Recargas' });
    case 'rides': return t('wallet.filter_rides', { defaultValue: 'Viajes' });
    case 'bonus': return t('wallet.filter_bonus', { defaultValue: 'Bonos' });
    case 'adjustment': return t('wallet.filter_adjustment', { defaultValue: 'Ajustes' });
    case 'all':
    default: return t('wallet.filter_all', { defaultValue: 'Todos' });
  }
}

function getFilterTypes(filter: FilterTab): string[] | null {
  switch (filter) {
    case 'recharge': return ['recharge'];
    case 'rides': return ['ride_payment', 'ride_hold', 'ride_hold_release', 'redemption'];
    case 'bonus': return ['promo_credit'];
    case 'adjustment': return ['adjustment'];
    default: return null;
  }
}

// ── Quick amount buttons (USD) — RECARGA V2 ──
// Customer presets. Corporate gets a richer set when a corporate
// account context is detected; that branch is wired below.
const QUICK_AMOUNTS_CUSTOMER = [20, 50, 100, 200];
const QUICK_AMOUNTS_CORPORATE = [100, 250, 500, 1000];
const MIN_RECHARGE_USD_CUSTOMER = RECHARGE_LIMITS.customer.min;
const MAX_RECHARGE_USD_CUSTOMER = RECHARGE_LIMITS.customer.max;
const MIN_RECHARGE_USD_CORPORATE = RECHARGE_LIMITS.corporate.min;
const MAX_RECHARGE_USD_CORPORATE = RECHARGE_LIMITS.corporate.max;

// ── Phase B6: basic device fingerprint ──
// A dependency-free SHA-256 hash of stable browser signals, recorded
// with the payment intent for fraud analysis and chargeback evidence.
// Fail-open: returns undefined if anything is unavailable.
async function computeDeviceFingerprint(): Promise<string | undefined> {
  try {
    if (typeof navigator === 'undefined' || typeof crypto === 'undefined' || !crypto.subtle) {
      return undefined;
    }
    const signals = [
      navigator.userAgent,
      navigator.language,
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.platform ?? '',
      String(navigator.hardwareConcurrency ?? ''),
    ].join('|');
    const bytes = new TextEncoder().encode(signals);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

export default function WalletPage() {
  const { t } = useTranslation('web');
  const router = useRouter();

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Wallet state ──
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<{
    available: number; held: number;
    availableUsdCents: number | null; heldUsdCents: number | null;
    migrationRate: number | null; migrationBonusPct: number | null;
    anchorUsdCents: number | null;
  }>({ available: 0, held: 0, availableUsdCents: null, heldUsdCents: null, migrationRate: null, migrationBonusPct: null, anchorUsdCents: null });
  const [balanceLoading, setBalanceLoading] = useState(true);

  // Wallet v2 migration banner (one-time, dismissible — parity con WalletMigrationBanner).
  const [migrationDismissed, setMigrationDismissed] = useState(true);
  useEffect(() => {
    setMigrationDismissed(localStorage.getItem('tricigo_wallet_migration_ack') === '1');
  }, []);

  // Receipt readiness after a recharge (poll the PDF generation, 6×2s).
  const [receiptReady, setReceiptReady] = useState(false);

  // ── Transactions state ──
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [txPage, setTxPage] = useState(0);
  const [txHasMore, setTxHasMore] = useState(true);
  const [txLoadingMore, setTxLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('all');

  // ── NETOPIA recharge state ──
  // The flow: user picks an amount → we call the edge function →
  // it returns a `redirectUrl` to the NETOPIA hosted payment page →
  // we `window.location.href` there. After settlement, NETOPIA
  // redirects back to /wallet?intent=<id>; we poll for `completed`.
  const [providerConfig, setProviderConfig] = useState<PaymentProviderConfig | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeStep, setRechargeStep] = useState<'amount' | 'redirecting' | 'verifying' | 'success' | 'failed'>('amount');
  const [rechargeError, setRechargeError] = useState<string | null>(null);
  const [rechargeLoading, setRechargeLoading] = useState(false);
  // RECARGA V2: track the just-completed intent so the success step can
  // surface a "Ver recibo" chip linking to /wallet/receipts. The PDF
  // EF runs async after the webhook so the file may not be ready the
  // very second the user lands on success — the receipts page handles
  // the "in process" state gracefully.
  const [successIntentId, setSuccessIntentId] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(DEFAULT_EXCHANGE_RATE);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load wallet + provider config ──
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function loadWallet() {
      setBalanceLoading(true);
      try {
        await walletService.ensureAccount(userId!);
        const [bal, acct, rate, activeProvider] = await Promise.all([
          walletService.getBalance(userId!),
          walletService.getAccount(userId!),
          exchangeRateService.getUsdCupRate(),
          paymentService.getActivePaymentProvider(),
        ]);
        const config = await paymentService.getPaymentProviderConfig(activeProvider);
        if (!cancelled) {
          setBalance(bal);
          setAccount(acct);
          setExchangeRate(rate);
          setProviderConfig(config);
        }
      } catch (err) {
        console.error('Failed to load wallet:', err);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    }

    loadWallet();
    return () => { cancelled = true; };
  }, [userId]);

  // ── Load transactions ──
  const loadTransactions = useCallback(async (acctId: string, page: number) => {
    const data = await walletService.getTransactions(acctId, page, 20);
    return data;
  }, []);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;

    async function fetchTx() {
      setTxLoading(true);
      try {
        const data = await loadTransactions(account!.id, 0);
        if (!cancelled) {
          setTransactions(data);
          setTxPage(0);
          setTxHasMore(data.length >= 20);
        }
      } catch (err) {
        console.error('Failed to load transactions:', err);
      } finally {
        if (!cancelled) setTxLoading(false);
      }
    }

    fetchTx();
    return () => { cancelled = true; };
  }, [account, loadTransactions]);

  // Refs so the mount-only NETOPIA-return closure below reads the CURRENT
  // auth/wallet state when its poll resolves. The original closure captured
  // the FIRST render's nulls (auth resolves async after mount), so the
  // post-payment balance/receipt refresh never executed — the screen said
  // "saldo actualizado" while showing the stale pre-credit values.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;
  const accountRef = useRef<WalletAccount | null>(null);
  accountRef.current = account;

  // ── Handle return from NETOPIA hosted payment page ──
  // NETOPIA redirects back to /wallet?intent=<id>. We poll the intent
  // until status is completed/failed (the webhook is the authoritative
  // event; polling is just UX to show the user the result without
  // requiring a refresh).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const intentId = params.get('intent');
    // Legacy success/cancel params from previous integrations — ignore.
    if (!intentId) return;
    if (intentId === 'success' || intentId === 'cancel') return;

    let cancelled = false;
    setRechargeStep('verifying');

    (async () => {
      try {
        const intent = await paymentService.pollIntentStatus(intentId, 20, 2000);
        if (cancelled) return;
        if (intent.status === 'completed') {
          setSuccessIntentId(intentId);
          setReceiptReady(false);
          setRechargeStep('success');
          // Refresh balance + transactions so the new credit shows. Read the
          // refs (not the captured state): by the time the poll resolves the
          // session has loaded, even though this effect mounted with nulls.
          const uid = userIdRef.current;
          if (uid) {
            try {
              const bal = await walletService.getBalance(uid);
              if (!cancelled) setBalance(bal);
              const acct = accountRef.current;
              if (acct) {
                const txns = await walletService.getTransactions(acct.id, 0, 20);
                if (!cancelled) setTransactions(txns as LedgerTransaction[]);
              }
            } catch { /* ignore — visual refresh, not critical */ }
            // Poll for the receipt PDF (generated async post-webhook), 6×2s —
            // fire-and-forget so it doesn't block the success UI. Mirrors the
            // mobile wallet's post-recharge receipt poll.
            (async () => {
              for (let i = 0; i < 6; i++) {
                if (cancelled) return;
                try {
                  const receipts = await walletService.getReceipts(uid);
                  const r = receipts.find((x) => x.payment_intent_id === intentId);
                  if (r?.pdf_generated_at) { if (!cancelled) setReceiptReady(true); return; }
                } catch { /* ignore */ }
                await new Promise((res) => setTimeout(res, 2000));
              }
            })();
          }
        } else if (intent.status === 'failed') {
          setRechargeError(intent.error_message ? translateNetopiaError(intent.error_message) : t('wallet.failed_short', { defaultValue: 'El pago no pudo ser procesado' }));
          setRechargeStep('failed');
        } else {
          // Still pending after poll exhausted — soft success (webhook will land soon)
          setSuccessIntentId(intentId);
          setRechargeStep('success');
        }
      } catch (err) {
        if (cancelled) return;
        setRechargeError(err instanceof Error ? err.message : t('wallet.verify_error', { defaultValue: 'No se pudo verificar el estado del pago' }));
        setRechargeStep('failed');
      } finally {
        // Clean the intent param from the URL so a refresh doesn't re-poll.
        if (!cancelled) window.history.replaceState({}, '', '/wallet');
      }
    })();

    return () => { cancelled = true; };
    // We intentionally run only on mount when the URL has the param.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refetch balance + transactions when the tab regains focus ──
  // Parity con el `useFocusEffect` del wallet móvil: el saldo puede haber
  // cambiado en otra pestaña o por un viaje mientras el wallet estaba en
  // segundo plano, así que refrescamos al volver al foco.
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (document.hidden) return;
      walletService.getBalance(userId).then(setBalance).catch(() => {});
      if (account) {
        walletService.getTransactions(account.id, 0, 20)
          .then((d) => { setTransactions(d as LedgerTransaction[]); setTxPage(0); setTxHasMore(d.length >= 20); })
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [userId, account]);

  // ── Auth gate ──
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>{t('wallet.loading', { defaultValue: 'Cargando...' })}</p>
        </div>
      </div>
    );
  }
  if (!userId) {
    router.replace('/login');
    return null;
  }

  // ── Filtered transactions ──
  const filterTypes = getFilterTypes(filter);
  const filteredTx = filterTypes
    ? transactions.filter((tx) => filterTypes.includes(tx.type))
    : transactions;

  async function handleLoadMoreTx() {
    if (!account || txLoadingMore) return;
    setTxLoadingMore(true);
    try {
      const nextPage = txPage + 1;
      const data = await loadTransactions(account.id, nextPage);
      setTransactions((prev) => [...prev, ...data]);
      setTxPage(nextPage);
      setTxHasMore(data.length >= 20);
    } catch (err) {
      console.error('Failed to load more transactions:', err);
    } finally {
      setTxLoadingMore(false);
    }
  }

  // ── Start NETOPIA recharge: create intent, then redirect to hosted page ──
  // RECARGA V2: user picks NET USD; the server adds a 3% min $0.50 fee
  // and tells NETOPIA the full charge (amountUsd + feeUsd).
  async function handleStartRecharge() {
    if (!userId || !providerConfig) return;
    const amountUsd = parseFloat(rechargeAmount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;

    if (amountUsd < MIN_RECHARGE_USD_CUSTOMER) {
      setRechargeError(t('wallet.recharge_min', { amount: MIN_RECHARGE_USD_CUSTOMER, defaultValue: 'Monto mínimo: ${{amount}} USD' }));
      return;
    }
    if (amountUsd > MAX_RECHARGE_USD_CUSTOMER) {
      setRechargeError(t('wallet.recharge_max', { amount: MAX_RECHARGE_USD_CUSTOMER, defaultValue: 'Monto máximo: ${{amount}} USD' }));
      return;
    }

    setRechargeLoading(true);
    setRechargeError(null);
    try {
      const deviceFingerprint = await computeDeviceFingerprint();
      const result = await paymentService.createRechargeIntent({
        provider: providerConfig.provider,
        userId,
        amountUsd,
        deviceFingerprint,
      });
      if (!result.redirectUrl) {
        throw new Error(t('wallet.recharge_error_no_url', { defaultValue: 'El procesador no devolvió una URL de pago' }));
      }
      setRechargeStep('redirecting');
      // Hand off to the NETOPIA hosted payment page. After the user
      // completes / cancels there, NETOPIA redirects back to
      // /wallet?intent=<id> and the useEffect above takes over.
      window.location.href = result.redirectUrl;
    } catch (err) {
      setRechargeError(err instanceof Error ? err.message : t('wallet.recharge_error_generic', { defaultValue: 'Error al iniciar la recarga' }));
      setRechargeLoading(false);
    }
  }

  function handleRechargeReset() {
    setRechargeStep('amount');
    setRechargeAmount('');
    setRechargeError(null);
    setSuccessIntentId(null);
  }

  // ── Helper: get amount from joined entry ──
  // Net effect on THIS account via the shared classifier (a gift/mixed ride
  // touches several accounts; reading entries[0] showed the wrong row/sign).
  function classifyTx(tx: LedgerTransaction) {
    const entries =
      (tx as unknown as { ledger_entries?: { account_id: string; amount: number }[] }).ledger_entries ?? [];
    return classifyWalletTxn(
      { type: tx.type, reference_type: tx.reference_type, metadata: tx.metadata, ledger_entries: entries },
      account?.id,
    );
  }

  // Net signed amount on the user's account, or null when the txn carries no
  // visible ledger entries (so the amount column hides instead of showing 0).
  function getTxAmount(tx: LedgerTransaction): number | null {
    const entries = (tx as unknown as { ledger_entries?: { account_id: string; amount: number }[] }).ledger_entries;
    if (!entries || entries.length === 0) return null;
    return classifyTx(tx).signedAmount;
  }

  // RECARGA V2: input is USD net. Derive fee + charge for preview using
  // the shared helpers so the on-screen math is byte-identical to what
  // the server (create-netopia-payment-intent) charges.
  const amountUsdNum = parseFloat(rechargeAmount) || 0;
  const previewFeeUsd = amountUsdNum > 0 ? computeRechargeFeeUsd(amountUsdNum) : 0;
  const previewChargeUsd = amountUsdNum > 0 ? computeRechargeChargeUsd(amountUsdNum) : 0;

  // Monthly insights "Este mes" (parity con BUG-280 del wallet móvil): sólo
  // cuenta débitos de `ride_payment`/`redemption` del mes actual → total
  // gastado, # de viajes y promedio. La card se oculta si no hubo viajes este
  // mes (evita "70k gastado / 0 viajes").
  const monthlyInsights = (() => {
    const now = new Date();
    const m = now.getMonth();
    const y = now.getFullYear();
    const ridePaymentTypes = new Set(['ride_payment', 'redemption']);
    const monthRideDebits = transactions.filter((tx) => {
      const d = new Date(tx.created_at);
      if (d.getMonth() !== m || d.getFullYear() !== y) return false;
      if (!ridePaymentTypes.has(tx.type)) return false;
      return (getTxAmount(tx) ?? 0) < 0;
    });
    const totalSpent = monthRideDebits.reduce((s, tx) => s + Math.abs(getTxAmount(tx) ?? 0), 0);
    const ridesCount = monthRideDebits.length;
    const avgRide = ridesCount > 0 ? Math.round(totalSpent / ridesCount) : 0;
    return { totalSpent, ridesCount, avgRide };
  })();

  return (
    <>
    <main className="page-main">
      <div className="page-container">
        <Link href="/" aria-label={t('wallet.back_home', { defaultValue: 'Volver al inicio' })} style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          {t('wallet.back_home_link', { defaultValue: '← Inicio' })}
        </Link>

        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          {t('wallet.title', { defaultValue: 'Mis créditos de viaje' })}
        </h1>

        {/* ═══ Wallet v2 migration banner (dismissible) ═══ */}
        {!migrationDismissed && balance.availableUsdCents != null && balance.migrationBonusPct != null && (() => {
          const bonusPct = balance.migrationBonusPct ?? 0;
          const usdCents = balance.availableUsdCents ?? 0;
          const showsBonus = bonusPct > 0;
          const bonusUsd = (usdCents / 100 / (1 + bonusPct / 100)) * (bonusPct / 100);
          return (
            <div role="alert" style={{ marginBottom: '1rem', borderRadius: '1rem', border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.08)', padding: '1rem' }}>
              <p style={{ fontSize: '0.85rem', fontWeight: 700, color: '#b45309', margin: '0 0 0.25rem' }}>
                {showsBonus
                  ? t('wallet.migration_bonus_title', { defaultValue: '🎁 ¡Nuevo TriciCoin con bono!' })
                  : t('wallet.migration_title', { defaultValue: 'TriciCoin actualizado' })}
              </p>
              <p style={{ fontSize: '0.8rem', color: '#92400e', margin: '0 0 0.75rem', lineHeight: 1.4 }}>
                {showsBonus
                  ? t('wallet.migration_bonus_text', { bonus: bonusUsd.toFixed(2), percent: bonusPct.toFixed(0), defaultValue: 'Tu saldo ahora se muestra en USD (1 TC ≡ 1 USD). Te regalamos ~${{bonus}} ({{percent}}%) como bienvenida al nuevo modelo.' })
                  : t('wallet.migration_text', { defaultValue: 'Tu saldo ahora se muestra en USD (1 TC ≡ 1 USD). Mismo importe, nueva unidad para reflejar el valor real.' })}
              </p>
              <button
                onClick={() => { localStorage.setItem('tricigo_wallet_migration_ack', '1'); setMigrationDismissed(true); }}
                style={{ background: '#ea580c', color: '#fff', border: 'none', borderRadius: '999px', padding: '0.4rem 1rem', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}
              >
                {t('wallet.migration_ack', { defaultValue: 'Entendido' })}
              </button>
            </div>
          );
        })()}

        {/* ═══ Balance card ═══ */}
        <div className="wallet-balance-card">
          {balanceLoading ? (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <p style={{ fontSize: '0.875rem', opacity: 0.8 }}>{t('wallet.loading_balance', { defaultValue: 'Cargando saldo...' })}</p>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 'var(--text-sm)', opacity: 0.8, margin: '0 0 0.25rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>
                {t('wallet.available_balance', { defaultValue: 'Saldo disponible' })}
              </p>
              {/* 00443: CUP is the primary figure (Cuban-first). When the wallet
                  is USD-anchored, show its protected dollar value as subtitle. */}
              <p style={{ fontSize: '2rem', fontWeight: 800, margin: '0 0 0.1rem' }}>
                {formatTriciCoin(balance.available)}
              </p>
              {balance.anchorUsdCents != null && (
                <p style={{ fontSize: '0.8rem', opacity: 0.85, margin: 0 }}>
                  &asymp; ${(balance.anchorUsdCents / 100).toFixed(2)} USD &middot; {t('wallet.protected_value', { defaultValue: 'valor protegido' })}
                </p>
              )}
              {balance.held > 0 && (
                <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.15)', borderRadius: '0.5rem' }}>
                  <p style={{ fontSize: '0.75rem', opacity: 0.8, margin: 0 }}>
                    {t('wallet.held', { amount: formatTriciCoin(balance.held), defaultValue: 'Retenido: {{amount}}' })}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ═══ Regalar (gift P2P) ═══ */}
        <Link
          href="/wallet/gift"
          aria-label={t('wallet.gift_aria', { defaultValue: 'Enviar un regalo de TriciCoin' })}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
            width: '100%', padding: '0.85rem', marginBottom: '1rem', borderRadius: '0.75rem',
            border: '1px solid var(--primary)', background: 'var(--bg-card)', color: 'var(--primary)',
            fontWeight: 700, fontSize: '0.9rem', textDecoration: 'none',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12" /><rect x="2" y="7" width="20" height="5" /><line x1="12" y1="22" x2="12" y2="7" /><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" /></svg>
          {t('wallet.gift', { defaultValue: 'Regalar' })}
        </Link>

        {/* ═══ Recharge section ═══ */}
        <div id="wallet-recharge" className="wallet-section-card" style={{ marginBottom: '1rem' }}>
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>
            {t('wallet.recharge_title', { defaultValue: 'Comprar créditos de viaje' })}
          </p>

          {rechargeStep === 'amount' && (
            <>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem' }}>
                {t('wallet.recharge_desc', { defaultValue: 'Comprá créditos de viaje con tarjeta de crédito o débito. Te vamos a llevar al sitio seguro del procesador para que completes el pago.' })}
              </p>

              {/* Quick amounts (USD) */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                {QUICK_AMOUNTS_CUSTOMER.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => { setRechargeAmount(String(amt)); setRechargeError(null); }}
                    className="btn-base"
                    style={{
                      padding: '0.4rem 0.8rem',
                      fontSize: '0.8rem',
                      background: rechargeAmount === String(amt) ? 'var(--primary)' : 'var(--bg-hover)',
                      color: rechargeAmount === String(amt) ? '#fff' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      borderRadius: '2rem',
                      border: 'none',
                      fontFamily: 'inherit',
                    }}
                  >
                    ${amt}
                  </button>
                ))}
              </div>

              {/* Custom amount (USD) */}
              <div style={{ marginBottom: '0.5rem' }}>
                <input
                  type="number"
                  placeholder={t('wallet.recharge_amount_placeholder', { defaultValue: 'Monto en USD' })}
                  aria-label={t('wallet.recharge_amount_aria', { defaultValue: 'Monto de recarga en USD' })}
                  value={rechargeAmount}
                  onChange={(e) => { setRechargeAmount(e.target.value); setRechargeError(null); }}
                  className="input-base"
                  style={{ width: '100%' }}
                  min={MIN_RECHARGE_USD_CUSTOMER}
                  max={MAX_RECHARGE_USD_CUSTOMER}
                  step="1"
                />
              </div>

              {/* Charge breakdown (additive fee). The translated string carries
                  the <strong> markup around the total; content is fully
                  app-controlled (formatted numbers only), so rendering it via
                  dangerouslySetInnerHTML is safe and keeps the bold emphasis. */}
              {amountUsdNum > 0 && (
                <p
                  style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem' }}
                  dangerouslySetInnerHTML={{ __html: t('wallet.recharge_breakdown', { charge: previewChargeUsd.toFixed(2), fee: previewFeeUsd.toFixed(2), defaultValue: 'Pagarás <strong>${{charge}} USD</strong> (incluye ${{fee}} de comisión de servicio)' }) }}
                />
              )}

              {rechargeError && (
                <p role="alert" aria-live="assertive" style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0 0 0.5rem' }}>{rechargeError}</p>
              )}

              <button
                onClick={handleStartRecharge}
                disabled={rechargeLoading || !rechargeAmount || amountUsdNum <= 0 || !providerConfig?.enabled}
                aria-label={t('wallet.recharge_continue_aria', { defaultValue: 'Continuar al pago' })}
                className="btn-base btn-primary-solid"
                style={{
                  width: '100%',
                  cursor: rechargeLoading || !rechargeAmount ? 'not-allowed' : 'pointer',
                  opacity: rechargeLoading || !rechargeAmount || amountUsdNum <= 0 ? 0.6 : 1,
                }}
              >
                {rechargeLoading
                  ? t('wallet.recharge_preparing', { defaultValue: 'Preparando pago...' })
                  : t('wallet.recharge_continue', { defaultValue: 'Continuar al pago' })}
              </button>

              {!providerConfig?.enabled && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0.5rem 0 0', textAlign: 'center' }}>
                  {t('wallet.recharge_unavailable', { defaultValue: 'Compra de créditos con tarjeta no disponible temporalmente' })}
                </p>
              )}
            </>
          )}

          {rechargeStep === 'redirecting' && (
            <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
              {/* Visual: brand-tinted circle with external-link SVG (no emoji). */}
              <div
                aria-hidden
                style={{
                  width: 56, height: 56, borderRadius: '50%',
                  background: 'var(--primary-alpha-10)',
                  color: 'var(--primary)',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </div>
              <p style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.25rem' }}>{t('wallet.redirecting_title', { defaultValue: 'Redirigiéndote al procesador…' })}</p>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
                {t('wallet.redirecting_desc', { defaultValue: 'Vas a completar el pago de forma segura fuera de TriciGo.' })}
              </p>
            </div>
          )}

          {rechargeStep === 'verifying' && (
            <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
              <div className="spinner" style={{ width: 28, height: 28, margin: '0 auto 0.5rem' }} />
              <p style={{ fontSize: '0.95rem', fontWeight: 700, margin: '0 0 0.25rem' }}>{t('wallet.verifying_title', { defaultValue: 'Verificando tu pago…' })}</p>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
                {t('wallet.verifying_desc', { defaultValue: 'Esto puede tardar unos segundos.' })}
              </p>
            </div>
          )}

          {rechargeStep === 'success' && (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              {/* Visual: success badge with checkmark SVG (no emoji). */}
              <div
                aria-hidden
                style={{
                  width: 64, height: 64, borderRadius: '50%',
                  background: 'rgba(22, 163, 74, 0.12)',
                  color: '#16a34a',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <p style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.25rem' }}>{t('wallet.success_title', { defaultValue: 'Recarga exitosa' })}</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 1rem' }}>
                {t('wallet.success_desc', { defaultValue: 'Tu saldo ha sido actualizado.' })}
              </p>
              {/* RECARGA V2: surface the receipt as soon as the user lands on success.
                  The PDF generation runs async post-webhook (a few seconds), so the
                  receipts page handles the "still generating" state — clicking
                  here always works, even if the file isn't ready yet. */}
              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                {successIntentId && (
                  <Link
                    href="/wallet/receipts"
                    aria-label={t('wallet.view_receipt_aria', { defaultValue: 'Ver mis comprobantes de recarga' })}
                    className="btn-base btn-primary-solid"
                    style={{ cursor: 'pointer', textDecoration: 'none', opacity: receiptReady ? 1 : 0.85 }}
                  >
                    {receiptReady
                      ? t('wallet.view_receipt', { defaultValue: 'Ver recibo' })
                      : t('wallet.generating_receipt', { defaultValue: 'Generando recibo…' })}
                  </Link>
                )}
                <button
                  onClick={handleRechargeReset}
                  className="btn-base btn-secondary-outline"
                  style={{ cursor: 'pointer' }}
                >
                  {t('wallet.another_recharge', { defaultValue: 'Realizar otra recarga' })}
                </button>
              </div>
            </div>
          )}

          {rechargeStep === 'failed' && (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              {/* Visual: error badge with alert-triangle SVG (no emoji).
                  Note: the P2P Transfer section that lived here in master was
                  intentionally removed in Phase A (closed-loop TriciCoin) —
                  merge conflict resolution drops it. */}
              <div
                aria-hidden
                style={{
                  width: 64, height: 64, borderRadius: '50%',
                  background: 'rgba(220, 38, 38, 0.10)',
                  color: '#dc2626',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <p style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.25rem' }}>{t('wallet.failed_title', { defaultValue: 'Pago no completado' })}</p>
              <p style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0 0 1rem' }}>
                {rechargeError ?? t('wallet.failed_desc', { defaultValue: 'El pago no pudo ser procesado.' })}
              </p>
              <button
                onClick={handleRechargeReset}
                className="btn-base btn-secondary-outline"
                style={{ cursor: 'pointer' }}
              >
                {t('wallet.retry', { defaultValue: 'Intentar de nuevo' })}
              </button>
            </div>
          )}
        </div>

        {/* ═══ Este mes — insights mensuales (parity con el wallet móvil) ═══ */}
        {monthlyInsights.ridesCount > 0 && (
          <div style={{ marginBottom: '1.5rem' }}>
            <p style={{ fontSize: '0.85rem', fontWeight: 700, margin: '0 0 0.5rem' }}>{t('wallet.this_month', { defaultValue: 'Este mes' })}</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {[
                { label: t('wallet.insight_spent', { defaultValue: 'Gastado' }), value: formatTriciCoin(monthlyInsights.totalSpent), usd: monthlyInsights.totalSpent },
                { label: t('wallet.insight_rides', { defaultValue: 'Viajes' }), value: String(monthlyInsights.ridesCount), usd: null as number | null },
                { label: t('wallet.insight_average', { defaultValue: 'Promedio' }), value: formatTriciCoin(monthlyInsights.avgRide), usd: monthlyInsights.avgRide },
              ].map((m) => (
                <div key={m.label} style={{ flex: 1, padding: '0.85rem 0.6rem', borderRadius: '0.75rem', border: '1px solid var(--border-light)', background: 'var(--bg-card)', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>{m.value}</div>
                  {m.usd != null && exchangeRate ? (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', marginTop: 1 }}>&asymp; ${(m.usd / exchangeRate).toFixed(2)}</div>
                  ) : null}
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: 2 }}>{m.label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══ Transaction history ═══ */}
        <div>
          {/* Persistent receipts link — antes /wallet/receipts sólo era
              alcanzable tras una recarga; ahora siempre desde el wallet. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 0.75rem' }}>
            <p style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>{t('wallet.history_title', { defaultValue: 'Historial de transacciones' })}</p>
            <Link href="/wallet/receipts" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', textDecoration: 'none', flexShrink: 0 }}>
              {t('wallet.view_receipts', { defaultValue: 'Ver recibos →' })}
            </Link>
          </div>

          <div className="wallet-filter-tabs" role="tablist" aria-label={t('wallet.filter_label', { defaultValue: 'Filtrar transacciones' })}>
            {FILTER_TAB_KEYS.map((tabKey) => {
              const tabLabel = filterTabLabel(tabKey, t);
              return (
              <button
                key={tabKey}
                role="tab"
                aria-selected={filter === tabKey}
                aria-label={t('wallet.filter_aria', { label: tabLabel, defaultValue: 'Filtrar por {{label}}' })}
                onClick={() => setFilter(tabKey)}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: 'var(--radius-full)',
                  border: 'none',
                  background: filter === tabKey ? 'var(--primary)' : 'var(--bg-hover)',
                  color: filter === tabKey ? 'white' : 'var(--text-secondary)',
                  fontWeight: filter === tabKey ? 600 : 500,
                  fontSize: 'var(--text-sm)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all var(--transition-fast)',
                  fontFamily: 'inherit',
                  minHeight: '36px',
                }}
              >
                {tabLabel}
              </button>
              );
            })}
          </div>

          {txLoading && <WebSkeletonList count={4} />}

          {!txLoading && filteredTx.length === 0 && (
            <WebEmptyState
              icon="💰"
              title={filter !== 'all'
                ? t('wallet.empty_category_title', { defaultValue: 'Sin transacciones en esta categoría' })
                : t('wallet.empty_title', { defaultValue: 'Sin transacciones' })}
              description={t('wallet.empty_description', { defaultValue: 'Tus movimientos de TriciCoin aparecerán aquí.' })}
              action={filter !== 'all'
                ? { label: t('wallet.show_all', { defaultValue: 'Mostrar todos' }), onClick: () => setFilter('all') }
                : { label: t('wallet.recharge_balance', { defaultValue: 'Recargar saldo' }), onClick: () => document.getElementById('wallet-recharge')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
            />
          )}

          {!txLoading && filteredTx.length > 0 && (
            <div className="wallet-tx-list">
              {filteredTx.map((tx) => {
                const view = classifyTx(tx);
                const isCredit = view.isCredit;
                const amount = getTxAmount(tx);
                return (
                  <div key={tx.id} className="wallet-tx-item">
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: isCredit ? 'var(--success)' : 'var(--error)',
                      marginRight: '0.75rem',
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 'var(--text-sm)', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
                        {webTxLabel(view, t)}
                      </p>
                      {tx.description && (
                        <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0.15rem 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {tx.description}
                        </p>
                      )}
                      <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0.15rem 0 0' }}>
                        {getRelativeDay(tx.created_at, t('wallet.date_today', { defaultValue: 'Hoy' }), t('wallet.date_yesterday', { defaultValue: 'Ayer' }))} &middot; {formatTime(tx.created_at)}
                      </p>
                    </div>
                    {amount != null && (
                      <div style={{ flexShrink: 0, marginLeft: '0.5rem', textAlign: 'right' }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: 700, color: amount > 0 ? '#16a34a' : '#dc2626' }}>
                          {amount > 0 ? '+' : amount < 0 ? '−' : ''}{formatTriciCoin(Math.abs(amount))}
                        </span>
                        {(() => {
                          // USD caption — usa la tasa de migración si existe, si no
                          // cae a la tasa de cambio en vivo (parity con `migrationRate ?? exchangeRate`
                          // del wallet móvil), así las wallets pre-migración igual muestran ≈ $X.
                          const usdRate = balance.migrationRate ?? exchangeRate;
                          return usdRate ? (
                            <span style={{ display: 'block', fontSize: '0.65rem', color: 'var(--text-tertiary)', marginTop: 2 }}>
                              &asymp; {amount > 0 ? '+' : amount < 0 ? '-' : ''}${(Math.abs(amount) / usdRate).toFixed(2)}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}

              {txHasMore && (
                <button
                  onClick={handleLoadMoreTx}
                  disabled={txLoadingMore}
                  aria-label={t('wallet.load_more_aria', { defaultValue: 'Cargar mas transacciones' })}
                  className="btn-base btn-secondary-outline"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  {txLoadingMore ? <span className="spinner" style={{ width: 14, height: 14 }} /> : t('wallet.load_more', { defaultValue: 'Cargar mas transacciones' })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
    </>
  );
}
