'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { walletService, exchangeRateService, getSupabaseClient } from '@tricigo/api';
import { formatTRC, formatTRCasUSD, formatCUP, getRelativeDay, formatTime } from '@tricigo/utils';
import type { LedgerTransaction, WalletAccount } from '@tricigo/types';

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
        <div style={{ textAlign: 'center', color: '#999' }}>
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
      await walletService.requestRecharge(userId, amountCup);
      setRechargeSuccess(`Solicitud de recarga por ${formatCUP(amountCup)} enviada. Un agente la procesara pronto.`);
      setRechargeCup('');
    } catch (err) {
      console.error('Recharge error:', err);
      setRechargeError('Error al solicitar la recarga. Intenta de nuevo.');
    } finally {
      setRechargeLoading(false);
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
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '1rem' }}>
      <div style={{ maxWidth: 500, width: '100%' }}>
        <Link href="/" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
          &larr; Inicio
        </Link>

        <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontWeight: 800, marginTop: '1rem', marginBottom: '1.5rem' }}>
          Billetera TriciCoin
        </h1>

        {/* ═══ Balance card ═══ */}
        <div style={{
          padding: '1.5rem', borderRadius: '1rem', background: 'var(--primary)', color: 'white',
          marginBottom: '1.5rem',
        }}>
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
        <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #eee', background: 'white', marginBottom: '1rem' }}>
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>Recargar billetera</p>
          <p style={{ fontSize: '0.75rem', color: '#999', margin: '0 0 0.5rem' }}>
            Tasa actual: 1 USD = {exchangeRate} CUP
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="number"
              placeholder="Monto en CUP"
              value={rechargeCup}
              onChange={(e) => setRechargeCup(e.target.value)}
              style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid #ddd',
                fontSize: '0.875rem', outline: 'none',
              }}
            />
            <button
              onClick={handleRecharge}
              disabled={rechargeLoading || !rechargeCup}
              style={{
                padding: '0.75rem 1rem', borderRadius: '0.5rem', border: 'none',
                background: rechargeLoading || !rechargeCup ? '#ccc' : 'var(--primary)',
                color: 'white', fontWeight: 600, fontSize: '0.875rem',
                cursor: rechargeLoading || !rechargeCup ? 'not-allowed' : 'pointer',
              }}
            >
              {rechargeLoading ? '...' : 'Recargar'}
            </button>
          </div>
          {rechargeCup && !isNaN(parseInt(rechargeCup)) && parseInt(rechargeCup) > 0 && (
            <p style={{ fontSize: '0.75rem', color: '#666', margin: '0.35rem 0 0' }}>
              Recibiras aprox. {formatTRC(Math.round((parseInt(rechargeCup) / exchangeRate) * 100))}
            </p>
          )}
          {rechargeSuccess && <p style={{ fontSize: '0.8rem', color: '#16a34a', margin: '0.5rem 0 0' }}>{rechargeSuccess}</p>}
          {rechargeError && <p style={{ fontSize: '0.8rem', color: '#dc2626', margin: '0.5rem 0 0' }}>{rechargeError}</p>}
        </div>

        {/* ═══ P2P Transfer section ═══ */}
        <div style={{ padding: '1rem', borderRadius: '0.75rem', border: '1px solid #eee', background: 'white', marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.9rem', fontWeight: 700, margin: '0 0 0.75rem' }}>Enviar TriciCoin</p>

          {/* Phone search */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <input
              type="tel"
              placeholder="Telefono del destinatario"
              value={transferPhone}
              onChange={(e) => { setTransferPhone(e.target.value); setTransferRecipient(null); setTransferError(null); }}
              style={{
                flex: 1, padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid #ddd',
                fontSize: '0.875rem', outline: 'none',
              }}
            />
            <button
              onClick={handleFindRecipient}
              disabled={transferSearching || !transferPhone.trim()}
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
                <span style={{ color: '#999', marginLeft: '0.35rem' }}>{transferRecipient.phone}</span>
              </p>
            </div>
          )}

          {/* Amount + note */}
          {transferRecipient && (
            <>
              <input
                type="number"
                placeholder="Monto en centavos TRC"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid #ddd',
                  fontSize: '0.875rem', outline: 'none', marginBottom: '0.5rem', boxSizing: 'border-box',
                }}
              />
              {transferAmount && !isNaN(parseInt(transferAmount)) && parseInt(transferAmount) > 0 && (
                <p style={{ fontSize: '0.75rem', color: '#666', margin: '0 0 0.5rem' }}>
                  = {formatTRC(parseInt(transferAmount))} (~{formatTRCasUSD(parseInt(transferAmount))})
                </p>
              )}
              <input
                type="text"
                placeholder="Nota (opcional)"
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid #ddd',
                  fontSize: '0.875rem', outline: 'none', marginBottom: '0.5rem', boxSizing: 'border-box',
                }}
              />
              <button
                onClick={handleTransfer}
                disabled={transferSending || !transferAmount || parseInt(transferAmount) <= 0}
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
          <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1rem', overflowX: 'auto' }}>
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                style={{
                  padding: '0.4rem 0.75rem', borderRadius: '1rem', border: 'none',
                  background: filter === tab.key ? 'var(--primary)' : '#f3f4f6',
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
          {txLoading && (
            <div style={{ textAlign: 'center', padding: '2rem 0', color: '#999' }}>
              <div style={{
                width: 28, height: 28, border: '3px solid #eee', borderTopColor: 'var(--primary)',
                borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 0.5rem',
              }} />
              <p style={{ fontSize: '0.8rem' }}>Cargando transacciones...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* Empty */}
          {!txLoading && filteredTx.length === 0 && (
            <div style={{ textAlign: 'center', padding: '2rem 1rem', color: '#999' }}>
              <p style={{ fontSize: '0.875rem' }}>Sin transacciones {filter !== 'all' ? 'en esta categoria' : ''}</p>
            </div>
          )}

          {/* Transaction list */}
          {!txLoading && filteredTx.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {filteredTx.map((tx) => {
                const isCredit = CREDIT_TYPES.has(tx.type);
                const amount = getTxAmount(tx);
                return (
                  <div key={tx.id} style={{
                    padding: '0.75rem 1rem', borderRadius: '0.5rem', border: '1px solid #f3f4f6',
                    background: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: '0.8rem', fontWeight: 600, margin: 0, color: '#333' }}>
                        {TYPE_LABELS[tx.type] ?? tx.type}
                      </p>
                      {tx.description && (
                        <p style={{ fontSize: '0.7rem', color: '#999', margin: '0.15rem 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {tx.description}
                        </p>
                      )}
                      <p style={{ fontSize: '0.7rem', color: '#bbb', margin: '0.15rem 0 0' }}>
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
                  style={{
                    width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
                    border: '1px solid #ddd', background: 'white',
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
  );
}
