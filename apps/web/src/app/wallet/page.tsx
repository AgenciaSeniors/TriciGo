'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { walletService, exchangeRateService, paymentService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, formatTRCasUSD, DEFAULT_EXCHANGE_RATE, getRelativeDay, formatTime } from '@tricigo/utils';
import type { LedgerTransaction, WalletAccount, StripeRechargeConfig } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

type FilterTab = 'all' | 'recharge' | 'rides' | 'transfers';

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'recharge', label: 'Recargas' },
  { key: 'rides', label: 'Viajes' },
  { key: 'transfers', label: 'Transferencias' },
];

const TYPE_LABELS: Record<string, string> = {
  recharge: 'Recarga',
  ride_payment: 'Pago de viaje',
  ride_hold: 'Retencion de viaje',
  ride_hold_release: 'Liberacion de retencion',
  commission: 'Comision',
  transfer_in: 'Transferencia recibida',
  transfer_out: 'Transferencia enviada',
  promo_credit: 'Credito promocional',
  redemption: 'Canje',
  adjustment: 'Ajuste',
};

const CREDIT_TYPES = new Set(['recharge', 'transfer_in', 'promo_credit', 'ride_hold_release']);

function getFilterTypes(filter: FilterTab): string[] | null {
  switch (filter) {
    case 'recharge': return ['recharge'];
    case 'rides': return ['ride_payment', 'ride_hold', 'ride_hold_release'];
    case 'transfers': return ['transfer_in', 'transfer_out'];
    default: return null;
  }
}

// ── Quick amount buttons (CUP) ──
const QUICK_AMOUNTS = [500, 1000, 2000, 5000, 10000];

// ── Stripe checkout form (inside Elements provider) ──
function StripeCheckoutForm({
  amountCup,
  feeUsd,
  amountUsd,
  intentId,
  onSuccess,
  onError,
}: {
  amountCup: number;
  feeUsd: number;
  amountUsd: number;
  intentId: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/wallet?recharge=success`,
        },
        redirect: 'if_required',
      });

      if (error) {
        onError(error.message ?? 'Error al procesar el pago');
        setProcessing(false);
        return;
      }

      // Payment succeeded without redirect — poll for completion
      const result = await paymentService.pollIntentStatus(intentId, 15, 2000);
      if (result.status === 'completed') {
        onSuccess();
      } else if (result.status === 'failed') {
        onError(result.error_message ?? 'El pago no pudo ser procesado');
      } else {
        // Still processing — show success anyway (webhook will handle)
        onSuccess();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Error inesperado');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: '1rem' }}>
        <div style={{
          padding: '0.75rem',
          background: 'var(--bg-hover)',
          borderRadius: '0.5rem',
          marginBottom: '0.75rem',
          fontSize: '0.8rem',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
            <span>Recarga</span>
            <span style={{ fontWeight: 600 }}>{formatTRC(amountCup)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
            <span>~USD</span>
            <span>${amountUsd.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
            <span>Fee de servicio</span>
            <span>${feeUsd.toFixed(2)}</span>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            borderTop: '1px solid var(--border)', paddingTop: '0.25rem', marginTop: '0.25rem',
            fontWeight: 700,
          }}>
            <span>Total a cobrar</span>
            <span>${(amountUsd + feeUsd).toFixed(2)} USD</span>
          </div>
        </div>

        <PaymentElement options={{ layout: 'tabs' }} />
      </div>

      <button
        type="submit"
        disabled={!stripe || !elements || processing}
        className="btn-base btn-primary-solid"
        style={{
          width: '100%',
          opacity: processing ? 0.7 : 1,
          cursor: processing ? 'not-allowed' : 'pointer',
        }}
      >
        {processing ? 'Procesando...' : `Pagar $${(amountUsd + feeUsd).toFixed(2)} USD`}
      </button>
    </form>
  );
}

export default function WalletPage() {
  const router = useRouter();

  // ── Auth state ──
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Wallet state ──
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [balance, setBalance] = useState<{ available: number; held: number }>({ available: 0, held: 0 });
  const [balanceLoading, setBalanceLoading] = useState(true);

  // ── Transactions state ──
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);
  const [txPage, setTxPage] = useState(0);
  const [txHasMore, setTxHasMore] = useState(true);
  const [txLoadingMore, setTxLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterTab>('all');

  // ── Stripe recharge state ──
  const [stripeConfig, setStripeConfig] = useState<StripeRechargeConfig | null>(null);
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeStep, setRechargeStep] = useState<'amount' | 'payment' | 'success'>('amount');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [rechargeIntentId, setRechargeIntentId] = useState<string | null>(null);
  const [rechargeAmountUsd, setRechargeAmountUsd] = useState(0);
  const [rechargeFeeUsd, setRechargeFeeUsd] = useState(0);
  const [rechargeAmountCup, setRechargeAmountCup] = useState(0);
  const [rechargeError, setRechargeError] = useState<string | null>(null);
  const [rechargeLoading, setRechargeLoading] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<number>(DEFAULT_EXCHANGE_RATE);

  // ── P2P Transfer state ──
  const [transferPhone, setTransferPhone] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferRecipient, setTransferRecipient] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [transferSearching, setTransferSearching] = useState(false);
  const [transferSending, setTransferSending] = useState(false);
  const [transferSuccess, setTransferSuccess] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  // ── Auth effect ──
  useEffect(() => {
    getSupabaseClient().auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });
  }, []);

  // ── Load wallet + Stripe config ──
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function loadWallet() {
      setBalanceLoading(true);
      try {
        await walletService.ensureAccount(userId!);
        const [bal, acct, rate, config] = await Promise.all([
          walletService.getBalance(userId!),
          walletService.getAccount(userId!),
          exchangeRateService.getUsdCupRate(),
          paymentService.getStripeConfig(),
        ]);
        if (!cancelled) {
          setBalance(bal);
          setAccount(acct);
          setExchangeRate(rate);
          setStripeConfig(config);
          if (config.publishableKey && !config.publishableKey.includes('REPLACE')) {
            setStripePromise(loadStripe(config.publishableKey));
          }
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

  // ── Check URL params for recharge success redirect ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('recharge') === 'success') {
      setRechargeStep('success');
      // Clean URL
      window.history.replaceState({}, '', '/wallet');
    }
  }, []);

  // ── Auth gate ──
  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
            Trici<span style={{ color: 'var(--primary)' }}>Go</span>
          </div>
          <p style={{ fontSize: '0.875rem' }}>Cargando...</p>
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

  // ── Stripe recharge: create payment intent ──
  async function handleStartRecharge() {
    if (!userId) return;
    const amountCup = parseInt(rechargeAmount, 10);
    if (!amountCup || amountCup <= 0) return;

    if (stripeConfig) {
      if (amountCup < stripeConfig.minRechargeCup) {
        setRechargeError(`Monto minimo: ${formatTRC(stripeConfig.minRechargeCup)}`);
        return;
      }
      if (amountCup > stripeConfig.maxRechargeCup) {
        setRechargeError(`Monto maximo: ${formatTRC(stripeConfig.maxRechargeCup)}`);
        return;
      }
    }

    setRechargeLoading(true);
    setRechargeError(null);
    try {
      const result = await paymentService.createStripePaymentIntent(userId, amountCup);
      setClientSecret(result.clientSecret);
      setRechargeIntentId(result.intentId);
      setRechargeAmountUsd(result.amountUsd);
      setRechargeFeeUsd(result.feeUsd);
      setRechargeAmountCup(amountCup);
      setRechargeStep('payment');
    } catch (err) {
      setRechargeError(err instanceof Error ? err.message : 'Error al iniciar la recarga');
    } finally {
      setRechargeLoading(false);
    }
  }

  async function handleRechargeSuccess() {
    setRechargeStep('success');
    // Refresh balance
    if (userId) {
      try {
        const bal = await walletService.getBalance(userId);
        setBalance(bal);
        if (account) {
          const txns = await walletService.getTransactions(account.id, 0, 20);
          setTransactions(txns as LedgerTransaction[]);
        }
      } catch { /* ignore */ }
    }
  }

  function handleRechargeReset() {
    setRechargeStep('amount');
    setRechargeAmount('');
    setClientSecret(null);
    setRechargeIntentId(null);
    setRechargeError(null);
  }

  async function handleFindRecipient() {
    if (!transferPhone.trim()) return;
    setTransferSearching(true);
    setTransferRecipient(null);
    setTransferError(null);
    try {
      const user = await walletService.findUserByPhone(transferPhone.trim());
      if (user) {
        setTransferRecipient(user);
      } else {
        setTransferError('No se encontro un usuario con ese numero.');
      }
    } catch {
      setTransferError('Error al buscar el usuario.');
    } finally {
      setTransferSearching(false);
    }
  }

  async function handleTransfer() {
    const amount = parseInt(transferAmount, 10);
    if (!userId || !transferRecipient || isNaN(amount) || amount <= 0) return;
    setTransferSending(true);
    setTransferSuccess(null);
    setTransferError(null);
    try {
      await walletService.transferP2P(userId, transferRecipient.id, amount, transferNote || undefined);
      setTransferSuccess(`Transferencia de ${formatTRC(amount)} enviada a ${transferRecipient.full_name}.`);
      setTransferPhone('');
      setTransferAmount('');
      setTransferNote('');
      setTransferRecipient(null);
      const bal = await walletService.getBalance(userId);
      setBalance(bal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('insufficient') || msg.includes('Insufficient')) {
        setTransferError('Saldo insuficiente para esta transferencia.');
      } else {
        setTransferError('Error al realizar la transferencia. Intenta de nuevo.');
      }
    } finally {
      setTransferSending(false);
    }
  }

  // ── Helper: get amount from joined entry ──
  function getTxAmount(tx: LedgerTransaction): number | null {
    const entries = (tx as unknown as { ledger_entries: { account_id: string; amount: number }[] }).ledger_entries;
    if (!entries || entries.length === 0) return null;
    return entries[0].amount;
  }

  const amountCupNum = parseInt(rechargeAmount, 10) || 0;
  const estimatedUsd = amountCupNum > 0 ? (amountCupNum / exchangeRate).toFixed(2) : '0.00';

  return (
    <>
    <main className="page-main">
      <div className="page-container">
        <Link href="/" aria-label="Volver al inicio" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Inicio
        </Link>

        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Billetera TriciCoin
        </h1>

        {/* ═══ Balance card ═══ */}
        <div className="wallet-balance-card">
          {balanceLoading ? (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <p style={{ fontSize: '0.875rem', opacity: 0.8 }}>Cargando saldo...</p>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 'var(--text-sm)', opacity: 0.8, margin: '0 0 0.25rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>
                Saldo disponible
              </p>
              <p style={{ fontSize: '2rem', fontWeight: 800, margin: '0 0 0.25rem' }}>
                {formatTRC(balance.available)}
              </p>
              <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>
                ~{formatTRCasUSD(balance.available)}
              </p>
              {balance.held > 0 && (
                <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.15)', borderRadius: '0.5rem' }}>
                  <p style={{ fontSize: '0.75rem', opacity: 0.8, margin: 0 }}>
                    Retenido: {formatTRC(balance.held)}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ═══ Recharge section ═══ */}
        <div className="wallet-section-card" style={{ marginBottom: '1rem' }}>
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>
            Recargar billetera
          </p>

          {rechargeStep === 'amount' && (
            <>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.75rem' }}>
                Recarga tu billetera con tarjeta de credito o debito via Stripe.
              </p>

              {/* Quick amounts */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                {QUICK_AMOUNTS.map((amt) => (
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
                    {formatTRC(amt)}
                  </button>
                ))}
              </div>

              {/* Custom amount */}
              <div style={{ marginBottom: '0.5rem' }}>
                <input
                  type="number"
                  placeholder="Monto en CUP"
                  aria-label="Monto de recarga en CUP"
                  value={rechargeAmount}
                  onChange={(e) => { setRechargeAmount(e.target.value); setRechargeError(null); }}
                  className="input-base"
                  style={{ width: '100%' }}
                  min={stripeConfig?.minRechargeCup ?? 500}
                  max={stripeConfig?.maxRechargeCup ?? 50000}
                />
              </div>

              {/* USD estimate */}
              {amountCupNum > 0 && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem' }}>
                  ≈ ${estimatedUsd} USD + ${stripeConfig?.feeUsd.toFixed(2) ?? '2.00'} fee = <strong>${(parseFloat(estimatedUsd) + (stripeConfig?.feeUsd ?? 2)).toFixed(2)} USD total</strong>
                </p>
              )}

              {rechargeError && (
                <p style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0 0 0.5rem' }}>{rechargeError}</p>
              )}

              <button
                onClick={handleStartRecharge}
                disabled={rechargeLoading || !rechargeAmount || amountCupNum <= 0 || !stripeConfig?.enabled}
                aria-label="Continuar al pago"
                className="btn-base btn-primary-solid"
                style={{
                  width: '100%',
                  cursor: rechargeLoading || !rechargeAmount ? 'not-allowed' : 'pointer',
                  opacity: rechargeLoading || !rechargeAmount || amountCupNum <= 0 ? 0.6 : 1,
                }}
              >
                {rechargeLoading ? 'Preparando pago...' : 'Continuar al pago'}
              </button>

              {!stripeConfig?.enabled && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0.5rem 0 0', textAlign: 'center' }}>
                  Recargas con tarjeta no disponibles temporalmente
                </p>
              )}
            </>
          )}

          {rechargeStep === 'payment' && clientSecret && stripePromise && (
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
              <div style={{ marginBottom: '0.5rem' }}>
                <button
                  onClick={handleRechargeReset}
                  className="btn-base"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: '0.8rem', color: 'var(--primary)', padding: 0,
                    fontFamily: 'inherit',
                  }}
                >
                  &larr; Cambiar monto
                </button>
              </div>
              <StripeCheckoutForm
                amountCup={rechargeAmountCup}
                feeUsd={rechargeFeeUsd}
                amountUsd={rechargeAmountUsd}
                intentId={rechargeIntentId!}
                onSuccess={handleRechargeSuccess}
                onError={(msg) => setRechargeError(msg)}
              />
              {rechargeError && (
                <p style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0.5rem 0 0' }}>{rechargeError}</p>
              )}
            </Elements>
          )}

          {rechargeStep === 'success' && (
            <div style={{ textAlign: 'center', padding: '1rem 0' }}>
              <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✅</div>
              <p style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.25rem' }}>Recarga exitosa</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 1rem' }}>
                Tu saldo ha sido actualizado.
              </p>
              <button
                onClick={handleRechargeReset}
                className="btn-base btn-secondary-outline"
                style={{ cursor: 'pointer' }}
              >
                Realizar otra recarga
              </button>
            </div>
          )}
        </div>

        {/* ═══ P2P Transfer section ═══ */}
        <div className="wallet-section-card" style={{ marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>Enviar TriciCoin</p>

          <div className="wallet-input-row" style={{ marginBottom: '0.5rem' }}>
            <input
              type="tel"
              placeholder="Telefono del destinatario"
              aria-label="Telefono del destinatario"
              value={transferPhone}
              onChange={(e) => { setTransferPhone(e.target.value); setTransferRecipient(null); setTransferError(null); }}
              className="input-base"
              style={{ flex: 1 }}
            />
            <button
              onClick={handleFindRecipient}
              disabled={transferSearching || !transferPhone.trim()}
              aria-label="Buscar destinatario"
              className="btn-base"
              style={{
                background: transferSearching || !transferPhone.trim() ? 'var(--bg-hover)' : 'var(--text-primary)',
                color: transferSearching || !transferPhone.trim() ? 'var(--text-tertiary)' : '#fff',
                cursor: transferSearching || !transferPhone.trim() ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {transferSearching ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Buscar'}
            </button>
          </div>

          {transferRecipient && (
            <div style={{ padding: '0.5rem 0.75rem', borderRadius: '0.5rem', background: '#f0fdf4', border: '1px solid #86efac', marginBottom: '0.5rem' }}>
              <p style={{ fontSize: '0.8rem', margin: 0 }}>
                <span style={{ fontWeight: 600 }}>{transferRecipient.full_name}</span>
                <span style={{ color: 'var(--text-tertiary)', marginLeft: '0.35rem' }}>{transferRecipient.phone}</span>
              </p>
            </div>
          )}

          {transferRecipient && (
            <>
              <input
                type="number"
                placeholder="Monto en centavos TRC"
                aria-label="Monto de transferencia en centavos TRC"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                className="input-base"
                style={{ marginBottom: '0.5rem' }}
              />
              {transferAmount && !isNaN(parseInt(transferAmount)) && parseInt(transferAmount) > 0 && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem' }}>
                  = {formatTRC(parseInt(transferAmount))} (~{formatTRCasUSD(parseInt(transferAmount))})
                </p>
              )}
              <input
                type="text"
                placeholder="Nota (opcional)"
                aria-label="Nota para la transferencia"
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                className="input-base"
                style={{ marginBottom: '0.5rem' }}
              />
              <button
                onClick={handleTransfer}
                disabled={transferSending || !transferAmount || parseInt(transferAmount) <= 0}
                aria-label="Enviar transferencia"
                className="btn-base btn-primary-solid"
                style={{ width: '100%' }}
              >
                {transferSending ? 'Enviando...' : 'Enviar'}
              </button>
            </>
          )}

          {transferSuccess && <p style={{ fontSize: '0.8rem', color: '#16a34a', margin: '0.5rem 0 0' }}>{transferSuccess}</p>}
          {transferError && <p style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0.5rem 0 0' }}>{transferError}</p>}
        </div>

        {/* ═══ Transaction history ═══ */}
        <div>
          <p style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.75rem' }}>Historial de transacciones</p>

          <div className="wallet-filter-tabs" role="tablist" aria-label="Filtrar transacciones">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={filter === tab.key}
                aria-label={`Filtrar por ${tab.label}`}
                onClick={() => setFilter(tab.key)}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: 'var(--radius-full)',
                  border: 'none',
                  background: filter === tab.key ? 'var(--primary)' : 'var(--bg-hover)',
                  color: filter === tab.key ? 'white' : 'var(--text-secondary)',
                  fontWeight: filter === tab.key ? 600 : 500,
                  fontSize: 'var(--text-sm)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all var(--transition-fast)',
                  fontFamily: 'inherit',
                  minHeight: '36px',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {txLoading && <WebSkeletonList count={4} />}

          {!txLoading && filteredTx.length === 0 && (
            <WebEmptyState
              icon="💰"
              title={filter !== 'all' ? 'Sin transacciones en esta categoria' : 'Sin transacciones'}
              description="Tus movimientos de TriciCoin apareceran aqui."
            />
          )}

          {!txLoading && filteredTx.length > 0 && (
            <div className="wallet-tx-list">
              {filteredTx.map((tx) => {
                const isCredit = CREDIT_TYPES.has(tx.type);
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
                        {TYPE_LABELS[tx.type] ?? tx.type}
                      </p>
                      {tx.description && (
                        <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0.15rem 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {tx.description}
                        </p>
                      )}
                      <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0.15rem 0 0' }}>
                        {getRelativeDay(tx.created_at, 'Hoy', 'Ayer')} &middot; {formatTime(tx.created_at)}
                      </p>
                    </div>
                    {amount != null && (
                      <span style={{
                        fontSize: '0.9rem', fontWeight: 700, flexShrink: 0, marginLeft: '0.5rem',
                        color: amount > 0 ? '#16a34a' : '#dc2626',
                      }}>
                        {amount > 0 ? '+' : ''}{formatTRC(Math.abs(amount))}
                      </span>
                    )}
                  </div>
                );
              })}

              {txHasMore && filter === 'all' && (
                <button
                  onClick={handleLoadMoreTx}
                  disabled={txLoadingMore}
                  aria-label="Cargar mas transacciones"
                  className="btn-base btn-secondary-outline"
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  {txLoadingMore ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Cargar mas transacciones'}
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
