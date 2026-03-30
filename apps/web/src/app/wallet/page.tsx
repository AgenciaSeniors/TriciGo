'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { walletService, exchangeRateService, paymentService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, formatTRCasUSD, formatCUP, getRelativeDay, formatTime } from '@tricigo/utils';
import type { LedgerTransaction, WalletAccount } from '@tricigo/types';
import { WebSkeletonList } from '@/components/WebSkeleton';
import { WebEmptyState } from '@/components/WebEmptyState';

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

  // ── Recharge state ──
  const [rechargeCup, setRechargeCup] = useState('');
  const [rechargeLoading, setRechargeLoading] = useState(false);
  const [rechargeSuccess, setRechargeSuccess] = useState<string | null>(null);
  const [rechargeError, setRechargeError] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(520);

  // ── TropiPay iframe state ──
  const [tropipayUrl, setTropipayUrl] = useState<string | null>(null);
  const [tropipayPolling, setTropipayPolling] = useState(false);

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

  // ── Load wallet data ──
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function loadWallet() {
      setBalanceLoading(true);
      try {
        await walletService.ensureAccount(userId!);
        const [bal, acct, rate] = await Promise.all([
          walletService.getBalance(userId!),
          walletService.getAccount(userId!),
          exchangeRateService.getUsdCupRate(),
        ]);
        if (!cancelled) {
          setBalance(bal);
          setAccount(acct);
          setExchangeRate(rate);
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

  // ── Auth gate (after all hooks) ──
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
  if (!userId) { router.replace('/login'); return null; }

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

  async function handleRecharge() {
    const amountCup = parseInt(rechargeCup, 10);
    if (!userId || isNaN(amountCup) || amountCup <= 0) return;
    setRechargeLoading(true);
    setRechargeSuccess(null);
    setRechargeError(null);
    try {
      const result = await paymentService.createRechargeLink(userId, amountCup);
      setTropipayUrl(result.paymentUrl);
      setRechargeCup('');
      // Poll for balance change
      setTropipayPolling(true);
      const startBalance = balance.available;
      const pollInterval = setInterval(async () => {
        try {
          const bal = await walletService.getBalance(userId);
          if (bal.available !== startBalance) {
            clearInterval(pollInterval);
            setTropipayPolling(false);
            setTropipayUrl(null);
            setBalance(bal);
            setRechargeSuccess('Recarga completada exitosamente.');
            if (account) loadTransactions(account.id, 0).then(setTransactions);
          }
        } catch { /* ignore polling errors */ }
      }, 5000);
      // Stop polling after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        setTropipayPolling(false);
      }, 300000);
    } catch (err) {
      console.error('Recharge error:', err);
      setRechargeError('Error al generar el link de pago. Intenta de nuevo.');
    } finally {
      setRechargeLoading(false);
    }
  }

  function closeTropipayModal() {
    setTropipayUrl(null);
    setTropipayPolling(false);
    // Refresh balance in case payment completed
    if (userId) {
      walletService.getBalance(userId).then(setBalance).catch(() => {});
      loadTransactions(userId, filter);
    }
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
    } catch (err) {
      console.error('Find user error:', err);
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
      // Refresh balance
      const bal = await walletService.getBalance(userId);
      setBalance(bal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('insufficient') || msg.includes('Insufficient')) {
        setTransferError('Saldo insuficiente para esta transferencia.');
      } else {
        setTransferError('Error al realizar la transferencia. Intenta de nuevo.');
      }
      console.error('Transfer error:', err);
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
              <p style={{ fontSize: '0.8rem', opacity: 0.8, margin: '0 0 0.25rem' }}>Saldo disponible</p>
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
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>Recargar billetera</p>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '0 0 0.5rem' }}>
            Tasa actual: 1 USD = {exchangeRate} CUP
          </p>
          <div className="wallet-input-row">
            <input
              type="number"
              placeholder="Monto en CUP"
              aria-label="Monto de recarga en CUP"
              value={rechargeCup}
              onChange={(e) => setRechargeCup(e.target.value)}
              style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                fontSize: '0.875rem', outline: 'none',
              }}
            />
            <button
              onClick={handleRecharge}
              disabled={rechargeLoading || !rechargeCup}
              aria-label="Solicitar recarga"
              style={{
                padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none',
                background: rechargeLoading || !rechargeCup ? '#ccc' : 'var(--primary)',
                color: 'white', fontWeight: 600, fontSize: '0.875rem',
                cursor: rechargeLoading || !rechargeCup ? 'not-allowed' : 'pointer',
              }}
            >
              {rechargeLoading ? '...' : 'Pagar con TropiPay'}
            </button>
          </div>
          {rechargeCup && !isNaN(parseInt(rechargeCup)) && parseInt(rechargeCup) > 0 && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.35rem 0 0' }}>
              Recibiras aprox. {formatTRC(Math.round((parseInt(rechargeCup) / exchangeRate) * 100))}
            </p>
          )}
          {rechargeSuccess && <p style={{ fontSize: '0.8rem', color: '#16a34a', margin: '0.5rem 0 0' }}>{rechargeSuccess}</p>}
          {rechargeError && <p style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0.5rem 0 0' }}>{rechargeError}</p>}
        </div>

        {/* ═══ P2P Transfer section ═══ */}
        <div className="wallet-section-card" style={{ marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>Enviar TriciCoin</p>

          {/* Phone search */}
          <div className="wallet-input-row" style={{ marginBottom: '0.5rem' }}>
            <input
              type="tel"
              placeholder="Telefono del destinatario"
              aria-label="Telefono del destinatario"
              value={transferPhone}
              onChange={(e) => { setTransferPhone(e.target.value); setTransferRecipient(null); setTransferError(null); }}
              style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                fontSize: '0.875rem', outline: 'none',
              }}
            />
            <button
              onClick={handleFindRecipient}
              disabled={transferSearching || !transferPhone.trim()}
              aria-label="Buscar destinatario"
              style={{
                padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none',
                background: transferSearching || !transferPhone.trim() ? '#ccc' : '#333',
                color: 'white', fontWeight: 600, fontSize: '0.8rem',
                cursor: transferSearching || !transferPhone.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {transferSearching ? '...' : 'Buscar'}
            </button>
          </div>

          {/* Recipient found */}
          {transferRecipient && (
            <div style={{ padding: '0.5rem 0.75rem', borderRadius: '0.5rem', background: '#f0fdf4', border: '1px solid #86efac', marginBottom: '0.5rem' }}>
              <p style={{ fontSize: '0.8rem', margin: 0 }}>
                <span style={{ fontWeight: 600 }}>{transferRecipient.full_name}</span>
                <span style={{ color: 'var(--text-tertiary)', marginLeft: '0.35rem' }}>{transferRecipient.phone}</span>
              </p>
            </div>
          )}

          {/* Amount + note */}
          {transferRecipient && (
            <>
              <input
                type="number"
                placeholder="Monto en centavos TRC"
                aria-label="Monto de transferencia en centavos TRC"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                  fontSize: '0.875rem', outline: 'none', marginBottom: '0.5rem', boxSizing: 'border-box',
                }}
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
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)',
                  fontSize: '0.875rem', outline: 'none', marginBottom: '0.5rem', boxSizing: 'border-box',
                }}
              />
              <button
                onClick={handleTransfer}
                disabled={transferSending || !transferAmount || parseInt(transferAmount) <= 0}
                aria-label="Enviar transferencia"
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: 'none',
                  background: transferSending ? '#ccc' : 'var(--primary)',
                  color: 'white', fontWeight: 600, fontSize: '0.875rem',
                  cursor: transferSending ? 'not-allowed' : 'pointer',
                }}
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

          {/* Filter tabs */}
          <div className="wallet-filter-tabs" role="tablist" aria-label="Filtrar transacciones">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={filter === tab.key}
                aria-label={`Filtrar por ${tab.label}`}
                onClick={() => setFilter(tab.key)}
                style={{
                  padding: '0.4rem 0.75rem', borderRadius: '1rem', border: 'none',
                  background: filter === tab.key ? 'var(--primary)' : 'var(--bg-hover)',
                  color: filter === tab.key ? 'white' : '#666',
                  fontWeight: filter === tab.key ? 600 : 400,
                  fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Loading */}
          {txLoading && <WebSkeletonList count={4} />}

          {/* Empty */}
          {!txLoading && filteredTx.length === 0 && (
            <WebEmptyState
              icon="💰"
              title={filter !== 'all' ? 'Sin transacciones en esta categoria' : 'Sin transacciones'}
              description="Tus movimientos de TriciCoin apareceran aqui."
            />
          )}

          {/* Transaction list */}
          {!txLoading && filteredTx.length > 0 && (
            <div className="wallet-tx-list">
              {filteredTx.map((tx) => {
                const isCredit = CREDIT_TYPES.has(tx.type);
                const amount = getTxAmount(tx);
                return (
                  <div key={tx.id} className="wallet-tx-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: '0.8rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
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

              {/* Load more */}
              {txHasMore && filter === 'all' && (
                <button
                  onClick={handleLoadMoreTx}
                  disabled={txLoadingMore}
                  aria-label="Cargar mas transacciones"
                  style={{
                    width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
                    border: '1px solid var(--border)', background: 'var(--bg-primary)',
                    cursor: txLoadingMore ? 'not-allowed' : 'pointer',
                    fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', marginTop: '0.25rem',
                  }}
                >
                  {txLoadingMore ? 'Cargando...' : 'Cargar mas transacciones'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </main>

      {/* ═══ TropiPay iframe modal ═══ */}
      {tropipayUrl && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
          onClick={closeTropipayModal}
        >
          <div
            style={{
              width: '100%', maxWidth: '500px', height: '90vh', maxHeight: '700px',
              background: 'white', borderRadius: '1rem', overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0.75rem 1rem', borderBottom: '1px solid #eee',
            }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Pago con TropiPay</span>
              {tropipayPolling && (
                <span style={{ fontSize: '0.7rem', color: '#f59e0b', fontWeight: 500 }}>
                  Esperando confirmacion...
                </span>
              )}
              <button
                onClick={closeTropipayModal}
                style={{
                  background: 'none', border: 'none', fontSize: '1.25rem',
                  cursor: 'pointer', color: '#666', lineHeight: 1,
                }}
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>
            <iframe
              src={tropipayUrl}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title="TropiPay Payment"
              allow="payment"
            />
          </div>
        </div>
      )}
    </>
  );
}
