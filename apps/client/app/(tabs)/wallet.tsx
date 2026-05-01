import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, FlatList, ActivityIndicator, RefreshControl, Image, Pressable, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { paymentService } from '@tricigo/api/services/payment';
import type { StripeRechargeConfig } from '@tricigo/types';
import { formatTriciCoin, formatTRCasUSD, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE, normalizeCubanPhone, isValidCubanPhone, getRelativeDay, triggerHaptic, triggerSelection, getErrorMessage, logger } from '@tricigo/utils';
import type { LedgerTransaction, LedgerEntryType } from '@tricigo/types';
import Toast from 'react-native-toast-message';
import { SkeletonListItem, SkeletonBalance } from '@tricigo/ui/Skeleton';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@tricigo/ui/Input';
import { colors, darkColors } from '@tricigo/theme';
import { Platform, useColorScheme, Linking } from 'react-native';
import { RIDE_CONFIG } from '@/config/ride';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

// Lazy require Stripe SDK (native only). Fallbacks keep web build compiling.
let useStripe: (() => {
  initPaymentSheet: (opts: Record<string, unknown>) => Promise<{ error?: { message: string; code?: string } }>;
  presentPaymentSheet: () => Promise<{ error?: { message: string; code?: string } }>;
}) | null = null;
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    useStripe = require('@stripe/stripe-react-native').useStripe;
  } catch {
    useStripe = null;
  }
}

/**
 * BUG-280 — wallet filter set realigned with actual customer-side
 * LedgerEntryType values:
 *   - 'commission' removed (driver-only, never matches customer rows)
 *   - 'adjustment' added (covers admin corrections + cancellation penalties
 *     that previously showed only under "Todos" with no chip)
 *   - 'promo_credit' added as 'bonus' (covers referral + promo bonuses)
 *
 *   ride_payment also matches ride_hold/ride_hold_release/redemption — the
 *   filter logic in `filteredTransactions` widens accordingly.
 */
type TxnFilter =
  | 'all'
  | 'recharge'
  | 'ride_payment'
  | 'transfer_in'
  | 'transfer_out'
  | 'bonus'
  | 'adjustment';

/** Map raw ledger entry_type + credit/debit to a human-readable i18n key */
function getTransactionLabel(
  type: string,
  isCredit: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const map: Record<string, string> = {
    // Actual LedgerEntryType values
    recharge: t('wallet.txn_recharge', { defaultValue: 'Recarga de saldo' }),
    ride_payment: isCredit
      ? t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' })
      : t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    ride_hold: t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    ride_hold_release: t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' }),
    commission: t('wallet.txn_commission', { defaultValue: 'Comisión' }),
    transfer_in: t('wallet.txn_transfer_received', { defaultValue: 'Transferencia recibida' }),
    transfer_out: t('wallet.txn_transfer_sent', { defaultValue: 'Transferencia enviada' }),
    promo_credit: t('wallet.txn_bonus', { defaultValue: 'Bonificación' }),
    redemption: t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    adjustment: isCredit
      ? t('wallet.txn_refund', { defaultValue: 'Reembolso' })
      : t('wallet.txn_commission', { defaultValue: 'Comisión' }),
    // Extended entry types from task spec (future-proof)
    ride_payment_debit: t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    ride_payment_credit: t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' }),
    transfer_credit: t('wallet.txn_transfer_received', { defaultValue: 'Transferencia recibida' }),
    transfer_debit: t('wallet.txn_transfer_sent', { defaultValue: 'Transferencia enviada' }),
    commission_debit: t('wallet.txn_commission', { defaultValue: 'Comisión' }),
    tip_credit: t('wallet.txn_tip_received', { defaultValue: 'Propina recibida' }),
    tip_debit: t('wallet.txn_tip_sent', { defaultValue: 'Propina enviada' }),
    refund_credit: t('wallet.txn_refund', { defaultValue: 'Reembolso' }),
    bonus_credit: t('wallet.txn_bonus', { defaultValue: 'Bonificación' }),
    referral_bonus: t('wallet.txn_referral_bonus', { defaultValue: 'Bonus de referido' }),
  };
  return map[type] ?? type;
}

// TriciCoin images
const tricoinLogo = require('../../assets/coins/tricoin-logo.png');
const tricoinSmall = require('../../assets/coins/tricoin-small.png');
const tricoinStack = require('../../assets/coins/tricoin-stack.png');

type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

function useDebouncePress(callback: (...args: unknown[]) => void, delayMs = 1000) {
  const lastPress = useRef(0);
  return useCallback((...args: unknown[]) => {
    const now = Date.now();
    if (now - lastPress.current < delayMs) return;
    lastPress.current = now;
    callback(...args);
  }, [callback, delayMs]);
}

// Web wallet: full-featured wallet UI for Expo web
function WebWalletScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);

  // Core wallet state
  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<TxnFilter>('all');

  // Pagination
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_SIZE = 20;

  // Recharge state
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);

  // Wallet v2 PR 4: receipt index by payment_intent_id so each recharge
  // txn can render a "Descargar comprobante" button.
  const [receiptByPiId, setReceiptByPiId] = useState<Map<string, { receipt_no: string; pdf_storage_path: string | null }>>(new Map());
  const [openingReceipt, setOpeningReceipt] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // P2P Transfer state
  const [transferPhone, setTransferPhone] = useState('');
  const [transferSearching, setTransferSearching] = useState(false);
  const [transferRecipient, setTransferRecipient] = useState<{ id: string; full_name: string } | null>(null);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState('');

  // Fetch wallet data
  const fetchData = useCallback(async (resetTxns = true) => {
    if (!userId) return;
    try {
      await walletService.ensureAccount(userId);
      const [balanceData, account] = await Promise.all([
        walletService.getBalance(userId),
        walletService.getAccount(userId),
      ]);
      setBalance(balanceData);
      setAccountId(account?.id ?? null);

      if (account?.id && resetTxns) {
        const txns = await walletService.getTransactions(account.id, 0, PAGE_SIZE);
        setTransactions(txns as TransactionWithAmount[]);
        setPage(0);
        setHasMore((txns as TransactionWithAmount[]).length >= PAGE_SIZE);
      }

      // Fetch exchange rate
      try {
        const rate = await exchangeRateService.getUsdCupRate();
        if (rate) setExchangeRate(rate);
      } catch { /* use default */ }

      // Wallet v2 PR 4: load user receipts so we can render the
      // "Descargar comprobante" button on matching recharge txns.
      try {
        const receipts = await walletService.getReceipts(userId, 100);
        const map = new Map<string, { receipt_no: string; pdf_storage_path: string | null }>();
        for (const r of receipts) {
          map.set(r.payment_intent_id, { receipt_no: r.receipt_no, pdf_storage_path: r.pdf_storage_path });
        }
        setReceiptByPiId(map);
      } catch (err) {
        logger.warn('Receipts fetch error (non-fatal)', { error: String(err) });
      }
    } catch (err) {
      logger.error('Wallet fetch error', { error: String(err) });
    }
  }, [userId]);

  // Wallet v2 PR 4: open the receipt PDF via a fresh signed URL.
  const openReceipt = useCallback(async (storagePath: string, receiptNo: string) => {
    setOpeningReceipt(receiptNo);
    try {
      const url = await walletService.getReceiptSignedUrl(storagePath);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      logger.error('Receipt open failed', { error: String(err) });
      Toast.show({ type: 'error', text1: t('wallet.receipt_open_failed', { defaultValue: 'No pudimos abrir el comprobante' }) });
    } finally {
      setOpeningReceipt(null);
    }
  }, [t]);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      await fetchData();
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [userId, fetchData]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Load more transactions
  const loadMore = useCallback(async () => {
    if (!accountId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const txns = await walletService.getTransactions(accountId, nextPage * PAGE_SIZE, PAGE_SIZE);
      const typed = txns as TransactionWithAmount[];
      setTransactions((prev) => [...prev, ...typed]);
      setPage(nextPage);
      setHasMore(typed.length >= PAGE_SIZE);
    } catch (err) {
      logger.error('Error loading more transactions', { error: String(err) });
    } finally {
      setLoadingMore(false);
    }
  }, [accountId, page, loadingMore, hasMore]);

  // Filtered transactions — same widening rules as native (BUG-280).
  const filteredTransactions = useMemo(() => {
    if (activeFilter === 'all') return transactions;
    return transactions.filter((tx) => {
      if (activeFilter === 'ride_payment') {
        return tx.type === 'ride_payment'
          || tx.type === 'ride_hold'
          || tx.type === 'ride_hold_release'
          || tx.type === 'redemption';
      }
      if (activeFilter === 'bonus') {
        return tx.type === 'promo_credit';
      }
      return tx.type === activeFilter;
    });
  }, [transactions, activeFilter]);

  const filterOptions: { key: TxnFilter; label: string }[] = [
    { key: 'all', label: t('wallet.filter_all', { defaultValue: 'Todos' }) },
    { key: 'recharge', label: t('wallet.filter_recharge', { defaultValue: 'Recargas' }) },
    { key: 'ride_payment', label: t('wallet.filter_rides', { defaultValue: 'Viajes' }) },
    { key: 'transfer_in', label: t('wallet.filter_received', { defaultValue: 'Recibidas' }) },
    { key: 'transfer_out', label: t('wallet.filter_sent', { defaultValue: 'Enviadas' }) },
    { key: 'bonus', label: t('wallet.filter_bonus', { defaultValue: 'Bonos' }) },
    { key: 'adjustment', label: t('wallet.filter_adjustment', { defaultValue: 'Ajustes' }) },
  ];

  // Stripe recharge for web (Expo web uses redirect flow — native uses payment sheet below)
  const submitRecharge = useCallback(async () => {
    if (!userId) return;
    Toast.show({ type: 'info', text1: t('wallet.recharge_web_hint', { defaultValue: 'Usa la version web (tricigo.com/wallet) para recargar con tarjeta' }) });
  }, [t, userId]);

  // P2P search recipient
  const searchRecipient = useCallback(async () => {
    if (!isValidCubanPhone(transferPhone)) return;
    setTransferSearching(true);
    setTransferRecipient(null);
    setTransferError('');
    try {
      const normalized = normalizeCubanPhone(transferPhone);
      const user = await walletService.findUserByPhone(normalized);
      if (user && user.id !== userId) {
        setTransferRecipient({ id: user.id, full_name: user.full_name });
      } else if (user && user.id === userId) {
        setTransferError(t('wallet.cannot_transfer_self', { defaultValue: 'No puedes transferirte a ti mismo' }));
      } else {
        setTransferError(t('wallet.transfer_user_not_found', { defaultValue: 'Usuario no encontrado' }));
      }
    } catch {
      setTransferError(t('errors.transfer_failed', { defaultValue: 'Error al buscar usuario' }));
    } finally {
      setTransferSearching(false);
    }
  }, [transferPhone, userId, t]);

  // P2P submit transfer
  const submitTransfer = useCallback(async () => {
    if (!transferRecipient || !userId) return;
    const amountNum = parseInt(transferAmount, 10);
    if (!amountNum || amountNum <= 0) return;
    const amountCentavos = amountNum * 100;
    if (amountCentavos > balance.available) {
      setTransferError(t('wallet.transfer_insufficient', { defaultValue: 'Saldo insuficiente' }));
      return;
    }
    setTransferSubmitting(true);
    setTransferError('');
    setTransferSuccess('');
    try {
      await walletService.transferP2P(userId, transferRecipient.id, amountCentavos, transferNote || undefined);
      setTransferSuccess(t('wallet.transfer_success', { defaultValue: 'Transferencia exitosa' }));
      setTransferPhone('');
      setTransferAmount('');
      setTransferNote('');
      setTransferRecipient(null);
      await fetchData();
    } catch (err) {
      setTransferError(getErrorMessage(err));
    } finally {
      setTransferSubmitting(false);
    }
  }, [transferRecipient, userId, transferAmount, balance.available, transferNote, t, fetchData]);

  // Login required
  if (!userId) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 justify-center items-center">
          <Text variant="body" color="secondary">{t('auth.login_required', { defaultValue: 'Inicia sesion para ver tu billetera' })}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded>
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="pt-4 pb-8">
          {/* ─── Balance Card ─── */}
          <View className="rounded-2xl p-5 mb-6" style={{ background: 'linear-gradient(135deg, #FF4D00, #FF8A5C)' } as any}>
            <View className="flex-row items-center gap-2.5 mb-3">
              <Image source={tricoinLogo} style={{ width: 40, height: 40 }} resizeMode="contain" />
              <Text variant="h4" className="font-semibold" style={{ color: '#fff' }}>{t('wallet.title', { defaultValue: 'Billetera TriciCoin' })}</Text>
            </View>
            <Text variant="caption" className="mb-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
              {t('wallet.available_balance', { defaultValue: 'Saldo disponible' })}
            </Text>
            <View className="flex-row items-center gap-2 mb-1">
              <Image source={tricoinSmall} style={{ width: 28, height: 28 }} resizeMode="contain" />
              <Text variant="h2" className="font-bold" style={{ color: '#fff' }}>
                {loading ? '...' : formatTriciCoin(balance.available)}
              </Text>
            </View>
            <Text variant="caption" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {loading ? '' : `\u2248 ${formatUSD(trcToUsd(balance.available, exchangeRate))}`}
            </Text>
            {balance.held > 0 && (
              <Text variant="caption" className="mt-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {t('wallet.held_balance', { defaultValue: 'En retencion' })}: {formatTriciCoin(balance.held)} ({`\u2248 ${formatUSD(trcToUsd(balance.held, exchangeRate))}`})
              </Text>
            )}
          </View>

          {/* ─── Filter Tabs ─── */}
          <Text variant="h4" className="mb-2">
            {t('wallet.history', { defaultValue: 'Historial' })}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
            <View className="flex-row gap-2">
              {filterOptions.map((opt) => (
                <Pressable
                  key={opt.key}
                  onPress={() => setActiveFilter(opt.key)}
                  className={`px-4 py-1.5 rounded-full border ${
                    activeFilter === opt.key
                      ? 'bg-primary-500 border-primary-500'
                      : 'bg-neutral-50 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
                  }`}
                >
                  <Text
                    variant="caption"
                    color={activeFilter === opt.key ? 'inverse' : 'secondary'}
                    className="font-medium"
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          {/* ─── Transaction List ─── */}
          {loading ? (
            <View>
              <SkeletonListItem />
              <SkeletonListItem />
              <SkeletonListItem />
            </View>
          ) : filteredTransactions.length === 0 ? (
            /* UX: split truly-empty from filter-empty. A first-time user
               (all transactions = 0, filter = 'all') gets a push-to-home
               CTA so "your wallet is empty" doesn't feel like a dead end.
               A filter-empty (e.g., filtered to "Recargas" but never
               recharged) gets a one-click clear. */
            activeFilter !== 'all' ? (
              <EmptyState
                icon="filter-outline"
                title={t('wallet.no_results_title', { defaultValue: 'Sin resultados' })}
                description={t('wallet.no_results_desc', { defaultValue: 'No hay transacciones que coincidan con este filtro.' })}
                action={{
                  label: t('wallet.show_all', { defaultValue: 'Mostrar todos' }),
                  onPress: () => setActiveFilter('all'),
                }}
              />
            ) : (
              <EmptyState
                icon="receipt-outline"
                title={t('wallet.no_transactions', { defaultValue: 'Sin transacciones' })}
                description={t('wallet.no_transactions_first_desc', { defaultValue: 'Pedí un viaje o recibí una transferencia para ver movimientos acá.' })}
                action={{
                  label: t('wallet.request_ride_cta', { defaultValue: 'Pedí tu primer viaje' }),
                  onPress: () => router.push('/(tabs)'),
                }}
              />
            )
          ) : (
            <View className="mb-6">
              {filteredTransactions.map((tx) => {
                const entry = tx.ledger_entries?.[0];
                const amount = entry?.amount ?? 0;
                const isCredit = amount > 0;
                // Wallet v2 PR 4: match this txn to a receipt via payment_intent_id.
                const receipt = tx.type === 'recharge' && tx.reference_type === 'payment_intent' && tx.reference_id
                  ? receiptByPiId.get(tx.reference_id)
                  : null;
                const canDownload = !!receipt?.pdf_storage_path;
                return (
                  <View key={tx.id} className="py-3 border-b border-neutral-100 dark:border-neutral-800">
                    <View className="flex-row items-center">
                      <View
                        style={{
                          width: 8, height: 8, borderRadius: 4, marginRight: 10,
                          backgroundColor: isCredit ? '#16a34a' : '#ef4444',
                        }}
                      />
                      <View className="flex-1">
                        <Text variant="bodySmall" numberOfLines={1}>
                          {getTransactionLabel(tx.type, isCredit, t)}
                        </Text>
                        {tx.description ? (
                          <Text variant="caption" color="tertiary" numberOfLines={1}>{tx.description}</Text>
                        ) : null}
                        <Text variant="caption" color="tertiary">{getRelativeDay(tx.created_at, t('today'), t('yesterday'))}</Text>
                      </View>
                      <Text
                        variant="body"
                        className={`font-semibold ${isCredit ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
                      >
                        {isCredit ? '+' : ''}{formatTriciCoin(amount)}
                      </Text>
                    </View>
                    {canDownload && receipt && (
                      <Pressable
                        onPress={() => openReceipt(receipt.pdf_storage_path!, receipt.receipt_no)}
                        disabled={openingReceipt === receipt.receipt_no}
                        style={{ marginTop: 6, marginLeft: 18, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('wallet.download_receipt_aria', { defaultValue: 'Descargar comprobante {{no}}', no: receipt.receipt_no })}
                      >
                        <Ionicons name="download-outline" size={13} color={colors.brand.orange} />
                        <Text variant="caption" style={{ color: colors.brand.orange, fontWeight: '600' }}>
                          {openingReceipt === receipt.receipt_no
                            ? t('wallet.opening_receipt', { defaultValue: 'Abriendo…' })
                            : t('wallet.download_receipt', { defaultValue: 'Comprobante' })}{' '}
                          <Text variant="caption" style={{ color: colors.brand.orange, fontFamily: 'monospace' }}>{receipt.receipt_no}</Text>
                        </Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
              {hasMore && (
                <Pressable
                  onPress={loadMore}
                  className="py-3 items-center"
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <ActivityIndicator size="small" color={colors.primary[500]} />
                  ) : (
                    <Text variant="bodySmall" color="primary" className="font-medium">
                      {t('wallet.load_more', { defaultValue: 'Cargar mas' })}
                    </Text>
                  )}
                </Pressable>
              )}
            </View>
          )}

          {/* ─── Recharge Section ─── */}
          <View className="bg-neutral-50 dark:bg-neutral-900 rounded-2xl p-5 mb-6">
            <Text variant="h4" className="mb-1">
              {t('wallet.recharge_title', { defaultValue: 'Recargar billetera' })}
            </Text>
            <Text variant="caption" color="tertiary" className="mb-4">
              {t('wallet.recharge_coming_soon', { defaultValue: 'Próximamente: recarga con tarjeta' })}
            </Text>
            <Button
              title={t('wallet.recharge', { defaultValue: 'Recargar' })}
              size="lg"
              fullWidth
              onPress={submitRecharge}
              variant="outline"
            />
          </View>

          {/* ─── P2P Transfer Section ─── */}
          <View className="bg-neutral-50 dark:bg-neutral-900 rounded-2xl p-5 mb-6">
            <Text variant="h4" className="mb-4">
              {t('wallet.transfer_title', { defaultValue: 'Transferir a otro usuario' })}
            </Text>

            {transferSuccess ? (
              <View className="bg-green-50 dark:bg-green-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-green-700 dark:text-green-300">{transferSuccess}</Text>
              </View>
            ) : null}
            {transferError ? (
              <View className="bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-red-700 dark:text-red-300">{transferError}</Text>
              </View>
            ) : null}

            {/* Phone search */}
            <Text variant="bodySmall" color="secondary" className="mb-2">
              {t('wallet.transfer_phone', { defaultValue: 'Telefono del destinatario' })}
            </Text>
            <View className="flex-row gap-2 mb-3">
              <View className="flex-1">
                <Input
                  placeholder="+53 5XXXXXXX"
                  value={transferPhone}
                  onChangeText={(text: string) => {
                    setTransferPhone(text);
                    setTransferRecipient(null);
                    setTransferError('');
                    setTransferSuccess('');
                  }}
                  keyboardType="phone-pad"
                  className="mb-0"
                />
              </View>
              <Button
                title={t('search', { defaultValue: 'Buscar' })}
                variant="outline"
                size="md"
                onPress={searchRecipient}
                loading={transferSearching}
                disabled={!isValidCubanPhone(transferPhone)}
              />
            </View>

            {/* Recipient found */}
            {transferRecipient && (
              <View className="bg-green-50 dark:bg-green-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-green-700 dark:text-green-300">
                  {t('wallet.transfer_to', { defaultValue: 'Enviar a: {{name}}', name: transferRecipient.full_name })}
                </Text>
              </View>
            )}

            {/* Amount + note */}
            {transferRecipient && (
              <>
                <Text variant="bodySmall" color="secondary" className="mb-2">
                  {t('wallet.transfer_amount', { defaultValue: 'Monto' })} (CUP)
                </Text>
                <Input
                  placeholder="100"
                  value={transferAmount}
                  onChangeText={setTransferAmount}
                  keyboardType="numeric"
                />
                <Text variant="bodySmall" color="secondary" className="mb-2">
                  {t('wallet.transfer_note', { defaultValue: 'Nota (opcional)' })}
                </Text>
                <Input
                  placeholder={t('wallet.transfer_note_hint', { defaultValue: 'Ej: Compartimos el viaje' })}
                  value={transferNote}
                  onChangeText={setTransferNote}
                  maxLength={200}
                />
                <Text variant="caption" color="tertiary" className="mb-3 text-center">
                  {t('wallet.balance', { defaultValue: 'Saldo' })}: {formatTriciCoin(balance.available)}
                </Text>
                <Button
                  title={t('wallet.transfer_confirm', { defaultValue: 'Enviar' })}
                  size="lg"
                  fullWidth
                  onPress={submitTransfer}
                  loading={transferSubmitting}
                  disabled={transferSubmitting || !transferAmount || parseInt(transferAmount, 10) <= 0}
                />
              </>
            )}
          </View>
        </View>
      </ScrollView>

    </Screen>
  );
}

function NativeWalletScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const userId = useAuthStore((s) => s.user?.id);

  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<TxnFilter>('all');

  // U3.4: Count-up animation for balance after recharge
  const [displayBalance, setDisplayBalance] = useState(0);
  const prevBalanceRef = useRef(0);

  useEffect(() => {
    if (balance?.available != null) {
      const prev = prevBalanceRef.current;
      const next = balance.available;
      if (next > prev && prev > 0) {
        // Count up animation
        const diff = next - prev;
        const steps = 20;
        const stepTime = 50; // 1s total
        let step = 0;
        const interval = setInterval(() => {
          step++;
          setDisplayBalance(Math.round(prev + (diff * step / steps)));
          if (step >= steps) {
            clearInterval(interval);
            setDisplayBalance(next);
          }
        }, stepTime);
        return () => clearInterval(interval);
      } else {
        setDisplayBalance(next);
      }
      prevBalanceRef.current = next;
    }
  }, [balance?.available]);

  // Recharge state — amount is in USD now (min 20 per business rules)
  const [rechargeSheetVisible, setRechargeSheetVisible] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('20');
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false);
  const [stripeConfig, setStripeConfig] = useState<StripeRechargeConfig | null>(null);

  // Stripe SDK hook (null on web / if SDK not available)
  const stripe = useStripe ? useStripe() : null;

  // Transfer state
  const [transferSheetVisible, setTransferSheetVisible] = useState(false);
  const [transferPhone, setTransferPhone] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferRecipient, setTransferRecipient] = useState<{ id: string; full_name: string } | null>(null);
  const [transferSearching, setTransferSearching] = useState(false);
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  // Processing guard to prevent double-submit across all wallet actions
  const [isProcessing, setIsProcessing] = useState(false);

  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);

  // Wallet v2 PR 4: receipt index by payment_intent_id.
  const [receiptByPiId, setReceiptByPiId] = useState<Map<string, { receipt_no: string; pdf_storage_path: string | null }>>(new Map());
  const [openingReceipt, setOpeningReceipt] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      await walletService.ensureAccount(userId);
      const [balanceData, account] = await Promise.all([
        walletService.getBalance(userId),
        walletService.getAccount(userId),
      ]);
      setBalance(balanceData);
      setAccountId(account?.id ?? null);

      if (account?.id) {
        const txns = await walletService.getTransactions(account.id, 0, 20);
        setTransactions(txns as TransactionWithAmount[]);
      }

      // Fetch exchange rate
      try {
        const rate = await exchangeRateService.getUsdCupRate();
        if (rate) setExchangeRate(rate);
      } catch { /* use default */ }

      // Wallet v2 PR 4: load user receipts for the download button.
      try {
        const receipts = await walletService.getReceipts(userId, 100);
        const map = new Map<string, { receipt_no: string; pdf_storage_path: string | null }>();
        for (const r of receipts) {
          map.set(r.payment_intent_id, { receipt_no: r.receipt_no, pdf_storage_path: r.pdf_storage_path });
        }
        setReceiptByPiId(map);
      } catch (err) {
        logger.warn('Receipts fetch error (non-fatal)', { error: String(err) });
      }

      // Fetch Stripe config (enabled + publishable key). Placeholder key
      // ('pk_test_REPLACE_WITH_YOUR_KEY') means Stripe isn't yet provisioned
      // for this env — UI will disable the card button with "Próximamente".
      try {
        const cfg = await paymentService.getStripeConfig();
        setStripeConfig(cfg);
      } catch { /* leave as null — card button stays disabled */ }
    } catch (err) {
      logger.error('Error fetching wallet', { error: String(err) });
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      await fetchData();
      if (!cancelled) setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [userId, fetchData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  // Recharge handlers
  const handleRecharge = () => {
    setRechargeAmount('');
    setRechargeSheetVisible(true);
  };

  const MAX_RECHARGE_CUP = RIDE_CONFIG.MAX_RECHARGE_AMOUNT;

  const MIN_RECHARGE_USD = 20;
  const MAX_RECHARGE_USD = 500;
  const stripeReady = !!stripeConfig
    && stripeConfig.enabled
    && !!stripeConfig.publishableKey
    && !stripeConfig.publishableKey.includes('REPLACE')
    && !!stripe;

  const submitRecharge = useCallback(async () => {
    if (!userId) return;

    // If Stripe not configured yet, fall back to web wallet (preserves the
    // current behaviour until real keys arrive).
    if (!stripeReady) {
      setRechargeSheetVisible(false);
      Toast.show({
        type: 'info',
        text1: t('wallet.recharge_web_hint', {
          defaultValue: 'Pagos con tarjeta desde la app — próximamente. Te llevamos a la versión web.',
        }),
      });
      Linking.openURL('https://tricigo.com/wallet');
      return;
    }

    const usd = parseFloat(rechargeAmount);
    if (!usd || isNaN(usd)) {
      Toast.show({ type: 'error', text1: t('wallet.invalid_amount', { defaultValue: 'Monto inválido' }) });
      return;
    }
    if (usd < MIN_RECHARGE_USD) {
      Toast.show({
        type: 'error',
        text1: t('wallet.recharge_below_min', {
          defaultValue: `El mínimo es $${MIN_RECHARGE_USD} USD`,
        }),
      });
      return;
    }
    if (usd > MAX_RECHARGE_USD) {
      Toast.show({
        type: 'error',
        text1: t('wallet.recharge_above_max', {
          defaultValue: `El máximo es $${MAX_RECHARGE_USD} USD`,
        }),
      });
      return;
    }

    setRechargeSubmitting(true);
    setIsProcessing(true);
    try {
      // USD → CUP (stored internally as CUP until TRC=USD rebase happens)
      const amountCup = Math.round(usd * exchangeRate);

      // 1. Create PaymentIntent on our backend (returns Stripe client_secret)
      const intent = await paymentService.createStripePaymentIntent(userId, amountCup, 'customer');
      const clientSecret = (intent as { client_secret?: string; clientSecret?: string }).client_secret
        ?? (intent as { clientSecret?: string }).clientSecret;
      const intentId = (intent as { intentId?: string; intent_id?: string }).intentId
        ?? (intent as { intent_id?: string }).intent_id;
      if (!clientSecret || !intentId) throw new Error('Payment intent response incomplete');

      // 2. Initialize Stripe PaymentSheet with the client secret
      if (!stripe) throw new Error('Stripe SDK not available');
      const initRes = await stripe.initPaymentSheet({
        paymentIntentClientSecret: clientSecret,
        merchantDisplayName: 'TriciGo',
        allowsDelayedPaymentMethods: false,
      });
      if (initRes.error) throw new Error(initRes.error.message);

      // 3. Present sheet to user — they enter card + confirm
      const presentRes = await stripe.presentPaymentSheet();
      if (presentRes.error) {
        // User canceled — silent exit
        if (presentRes.error.code === 'Canceled') return;
        throw new Error(presentRes.error.message);
      }

      // 4. Poll our payment_intents table until webhook processes (credits wallet)
      Toast.show({
        type: 'info',
        text1: t('wallet.processing_recharge', { defaultValue: 'Procesando recarga...' }),
      });
      const final = await paymentService.pollIntentStatus(intentId);
      if (final.status === 'completed') {
        setRechargeSheetVisible(false);
        Toast.show({
          type: 'success',
          text1: t('wallet.recharge_success', { defaultValue: '¡Recarga exitosa!' }),
          text2: `$${usd.toFixed(2)} USD ≈ ${amountCup.toLocaleString()} CUP`,
        });
        await fetchData();
      } else {
        Toast.show({
          type: 'error',
          text1: t('wallet.recharge_failed', { defaultValue: 'El pago no se completó' }),
        });
      }
    } catch (err) {
      logger.error('stripe_recharge_failed', { error: String(err) });
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setRechargeSubmitting(false);
      setIsProcessing(false);
    }
  }, [userId, stripeReady, stripe, rechargeAmount, exchangeRate, t, fetchData]);
  const debouncedSubmitRecharge = useDebouncePress(submitRecharge);

  // Transfer handlers
  const handleTransfer = async () => {
    setTransferPhone('');
    setTransferAmount('');
    setTransferNote('');
    setTransferRecipient(null);
    // X2.3: Refresh balance before opening transfer sheet to ensure freshness
    if (userId) {
      try {
        const freshBalance = await walletService.getBalance(userId);
        setBalance(freshBalance);
      } catch {
        // Best effort — continue with current balance
      }
    }
    setTransferSheetVisible(true);
  };

  const searchRecipient = async () => {
    if (!isValidCubanPhone(transferPhone)) return;
    setTransferSearching(true);
    setTransferRecipient(null);
    try {
      const normalized = normalizeCubanPhone(transferPhone);
      const user = await walletService.findUserByPhone(normalized);
      if (user && user.id !== userId) {
        setTransferRecipient({ id: user.id, full_name: user.full_name });
      } else if (user && user.id === userId) {
        Toast.show({ type: 'error', text1: t('wallet.cannot_transfer_self') });
      } else {
        Toast.show({ type: 'error', text1: t('wallet.transfer_user_not_found') });
      }
    } catch {
      Toast.show({ type: 'error', text1: t('errors.transfer_failed') });
    } finally {
      setTransferSearching(false);
    }
  };

  const submitTransfer = useCallback(async () => {
    if (isProcessing) return;
    if (!transferRecipient || !userId) return;
    const amountNum = parseInt(transferAmount, 10);
    if (!amountNum || amountNum <= 0) return;

    const amountCentavos = amountNum * 100;
    if (amountCentavos > balance.available) {
      Toast.show({ type: 'error', text1: t('wallet.transfer_insufficient') });
      return;
    }

    setIsProcessing(true);
    setTransferSubmitting(true);
    try {
      await walletService.transferP2P(
        userId,
        transferRecipient.id,
        amountCentavos,
        transferNote || undefined,
      );
      setTransferSheetVisible(false);
      triggerHaptic('success');
      Toast.show({ type: 'success', text1: t('wallet.transfer_success') });
      await fetchData();
    } catch (err) {
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setTransferSubmitting(false);
      setIsProcessing(false);
    }
  }, [transferRecipient, userId, transferAmount, balance.available, transferNote, t, fetchData, isProcessing]);
  const debouncedSubmitTransfer = useDebouncePress(submitTransfer);

  // BUG-280 — Monthly spending insights, fixed.
  //
  // Old calculation summed every debit as "totalSpent" and counted every
  // debit type as a ride. That produced confusing numbers like
  // "70,000 TC gastado / 0 viajes" when the only debits were admin
  // adjustments and ride_holds (which get released when the trip is
  // canceled, so they aren't real spending).
  //
  // New rules:
  //   - totalSpent counts ONLY settled ride payments (`ride_payment` and
  //     `redemption` debits). `ride_hold` is excluded — it's transient
  //     and gets released. `adjustment` debits are excluded — those are
  //     admin corrections, not user spending.
  //   - ridesCount and totalSpent share the same set of transactions, so
  //     the "Promedio" stays consistent (totalSpent / ridesCount).
  //   - The card hides itself when there are no rides this month so we
  //     never show "70k spent / 0 trips".
  const monthlyInsights = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const ridePaymentTypes = new Set<string>(['ride_payment', 'redemption']);

    const monthRideDebits = transactions.filter((tx) => {
      const txDate = new Date(tx.created_at);
      if (txDate.getMonth() !== currentMonth || txDate.getFullYear() !== currentYear) return false;
      if (!ridePaymentTypes.has(tx.type)) return false;
      const amount = tx.ledger_entries?.[0]?.amount ?? 0;
      return amount < 0;
    });

    const totalSpent = monthRideDebits.reduce((sum, tx) => {
      const amount = tx.ledger_entries?.[0]?.amount ?? 0;
      return sum + Math.abs(amount);
    }, 0);
    const ridesCount = monthRideDebits.length;
    const avgRide = ridesCount > 0 ? Math.round(totalSpent / ridesCount) : 0;

    return { totalSpent, ridesCount, avgRide };
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    if (activeFilter === 'all') return transactions;
    return transactions.filter((tx) => {
      // BUG-280 — widen ride_payment filter to catch the equivalent settled-
      // payment types so "Viajes" doesn't hide redemptions / hold releases.
      if (activeFilter === 'ride_payment') {
        return tx.type === 'ride_payment'
          || tx.type === 'ride_hold'
          || tx.type === 'ride_hold_release'
          || tx.type === 'redemption';
      }
      // 'bonus' chip captures promo + referral credits.
      if (activeFilter === 'bonus') {
        return tx.type === 'promo_credit';
      }
      return tx.type === activeFilter;
    });
  }, [transactions, activeFilter]);

  const filterOptions: { key: TxnFilter; label: string }[] = [
    { key: 'all', label: t('wallet.filter_all', { defaultValue: 'Todos' }) },
    { key: 'recharge', label: t('wallet.filter_recharge', { defaultValue: 'Recargas' }) },
    { key: 'ride_payment', label: t('wallet.filter_rides', { defaultValue: 'Viajes' }) },
    { key: 'transfer_in', label: t('wallet.filter_received', { defaultValue: 'Recibidas' }) },
    { key: 'transfer_out', label: t('wallet.filter_sent', { defaultValue: 'Enviadas' }) },
    { key: 'bonus', label: t('wallet.filter_bonus', { defaultValue: 'Bonos' }) },
    { key: 'adjustment', label: t('wallet.filter_adjustment', { defaultValue: 'Ajustes' }) },
  ];

  // Wallet v2 PR 4: native receipt opener uses Linking.openURL (web build
  // never reaches NativeWalletScreen, so window.open is not needed here).
  const openReceiptNative = useCallback(async (storagePath: string, receiptNo: string) => {
    setOpeningReceipt(receiptNo);
    try {
      const url = await walletService.getReceiptSignedUrl(storagePath);
      await Linking.openURL(url);
    } catch (err) {
      logger.error('Receipt open failed', { error: String(err) });
      Toast.show({ type: 'error', text1: t('wallet.receipt_open_failed', { defaultValue: 'No pudimos abrir el comprobante' }) });
    } finally {
      setOpeningReceipt(null);
    }
  }, [t]);

  const renderTransaction = ({ item, index }: { item: TransactionWithAmount; index: number }) => {
    const amount = item.ledger_entries?.[0]?.amount ?? 0;
    const isCredit = amount > 0;
    // Wallet v2 PR 4: only Stripe recharges (reference_type='payment_intent') get receipts.
    const receipt = item.type === 'recharge' && item.reference_type === 'payment_intent' && item.reference_id
      ? receiptByPiId.get(item.reference_id)
      : null;
    const canDownload = !!receipt?.pdf_storage_path;
    return (
      <AnimatedCard delay={Math.min(index * 60, 300)}>
        <View className="py-3 border-b border-neutral-100 dark:border-neutral-800" accessible={true}>
          <View className="flex-row items-center">
            <View className="flex-1">
              <Text variant="bodySmall" numberOfLines={1}>{item.description || getTransactionLabel(item.type, isCredit, t)}</Text>
              <Text variant="caption" color="tertiary">{getRelativeDay(item.created_at, t('today'), t('yesterday'))}</Text>
            </View>
            <Text
              variant="body"
              className={`font-semibold ${isCredit ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
            >
              {isCredit ? '+' : ''}{formatTriciCoin(amount)}
            </Text>
          </View>
          {canDownload && receipt && (
            <Pressable
              onPress={() => openReceiptNative(receipt.pdf_storage_path!, receipt.receipt_no)}
              disabled={openingReceipt === receipt.receipt_no}
              className="mt-1.5 self-start flex-row items-center"
              accessibilityRole="button"
              accessibilityLabel={t('wallet.download_receipt_aria', { defaultValue: 'Descargar comprobante {{no}}', no: receipt.receipt_no })}
            >
              <Ionicons name="download-outline" size={13} color={colors.brand.orange} />
              <Text variant="caption" style={{ color: colors.brand.orange, fontWeight: '600', marginLeft: 4 }}>
                {openingReceipt === receipt.receipt_no
                  ? t('wallet.opening_receipt', { defaultValue: 'Abriendo…' })
                  : t('wallet.download_receipt', { defaultValue: 'Comprobante' })}{' '}
                <Text variant="caption" style={{ color: colors.brand.orange, fontFamily: 'monospace' }}>{receipt.receipt_no}</Text>
              </Text>
            </Pressable>
          )}
        </View>
      </AnimatedCard>
    );
  };

  if (loading) {
    return (
      <Screen bg="white" padded>
        <View className="pt-4">
          <SkeletonBalance />
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded>
      {/* BUG-280 — header now uses pt-6 (was pt-4) so the page title clears
          the demo banner overlay shown in production-debug builds. The h3
          was previously cut off when the banner is on. */}
      <View className="pt-6 flex-1">
        <View className="flex-row items-center gap-2.5 mb-5">
          <Image source={tricoinLogo} style={{ width: 40, height: 40 }} resizeMode="contain" />
          <Text variant="h3">
            {t('wallet.title')}
          </Text>
        </View>

        <AnimatedCard delay={0}>
          {/* U3.4: Use displayBalance for count-up animation */}
          <BalanceBadge
            balance={displayBalance}
            held={balance.held}
            size="lg"
            showHeld
            coinIcon={tricoinSmall}
            GradientComponent={LinearGradient}
            gradientColors={['#FF4D00', '#FF8A5C']}
            className="mb-5"
          />
        </AnimatedCard>

        <View className="flex-row gap-3 mb-6">
          <Button
            title={t('wallet.recharge')}
            variant="primary"
            size="md"
            className="flex-1"
            onPress={handleRecharge}
          />
          <Button
            title={t('wallet.transfer')}
            variant="outline"
            size="md"
            className="flex-1"
            onPress={handleTransfer}
          />
        </View>

        {/* BUG-280 — "Este mes" now hides when there are no rides this month
            (previously showed "70,000 TC gastado / 0 viajes" because admin
            adjustments and ride_holds counted as spending). Always-on stats
            cards are visually noisy when there's nothing to show. */}
        {monthlyInsights.ridesCount > 0 && (
          <View className="mb-6">
            <Text variant="h4" className="mb-3">
              {t('wallet.this_month', { defaultValue: 'Este mes' })}
            </Text>
            <View className="flex-row gap-3">
              <View className="flex-1 bg-primary-50 dark:bg-primary-950 rounded-2xl p-4">
                <Text variant="caption" color="secondary" className="mb-1.5">
                  {t('wallet.total_spent', { defaultValue: 'Total gastado' })}
                </Text>
                <Text className="font-bold text-primary-700 dark:text-primary-300" style={{ fontSize: 17, fontVariant: ['tabular-nums'] as never }}>
                  {formatTriciCoin(monthlyInsights.totalSpent)}
                </Text>
              </View>
              <View className="flex-1 bg-primary-50 dark:bg-primary-950 rounded-2xl p-4">
                <Text variant="caption" color="secondary" className="mb-1.5">
                  {t('wallet.rides_count', { defaultValue: 'Viajes' })}
                </Text>
                <Text className="font-bold text-primary-700 dark:text-primary-300" style={{ fontSize: 17, fontVariant: ['tabular-nums'] as never }}>
                  {monthlyInsights.ridesCount}
                </Text>
              </View>
              <View className="flex-1 bg-primary-50 dark:bg-primary-950 rounded-2xl p-4">
                <Text variant="caption" color="secondary" className="mb-1.5">
                  {t('wallet.avg_ride', { defaultValue: 'Promedio' })}
                </Text>
                <Text className="font-bold text-primary-700 dark:text-primary-300" style={{ fontSize: 17, fontVariant: ['tabular-nums'] as never }}>
                  {formatTriciCoin(monthlyInsights.avgRide)}
                </Text>
              </View>
            </View>
          </View>
        )}

        <Text variant="h4" className="mb-3">
          {t('wallet.history')}
        </Text>

        {/* BUG-280 — filter chips height fix v2.
            Bug: when the FlatList below had few items (e.g. filter "Recargas"
            showing 2 rows), the parent flex-1 column gave extra vertical space
            to the chip ScrollView, and `flex-row` (default align-items: stretch)
            stretched every chip to fill that height — chips became huge ovals.
            Fix:
              1. ScrollView: style flexGrow:0 + maxHeight so it stops expanding.
              2. Wrapper: items-start (align-items: flex-start) so each chip
                 sizes to its content height regardless of the row height. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mb-3"
          style={{ flexGrow: 0, maxHeight: 48 }}
          contentContainerStyle={{ paddingRight: 16, alignItems: 'flex-start' }}
        >
          <View className="flex-row gap-2 items-start">
            {filterOptions.map((opt) => (
              <Pressable
                key={opt.key}
                onPress={() => { triggerSelection(); setActiveFilter(opt.key); }}
                hitSlop={{ top: 8, bottom: 8 }}
                className={`px-4 py-2 rounded-full border self-start ${
                  activeFilter === opt.key
                    ? 'bg-primary-500 border-primary-500'
                    : 'bg-neutral-50 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
                }`}
                accessibilityRole="radio"
                accessibilityState={{ selected: activeFilter === opt.key }}
              >
                <Text
                  variant="caption"
                  color={activeFilter === opt.key ? 'inverse' : 'secondary'}
                  className="font-medium"
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <FlatList
          data={filteredTransactions}
          keyExtractor={(item) => item.id}
          renderItem={renderTransaction}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.orange} />
          }
          ListEmptyComponent={
            /* UX: native gets the same split as web plus access to the
               recharge bottom sheet (web can't charge cards directly).
               Filter-empty → "Mostrar todos"; truly-empty → "Recargar
               saldo" as the primary because funding the wallet is the
               natural first step on day 1. */
            activeFilter !== 'all' ? (
              <EmptyState
                icon="filter-outline"
                title={t('wallet.no_results_title', { defaultValue: 'Sin resultados' })}
                description={t('wallet.no_results_desc', { defaultValue: 'No hay transacciones que coincidan con este filtro.' })}
                action={{
                  label: t('wallet.show_all', { defaultValue: 'Mostrar todos' }),
                  onPress: () => setActiveFilter('all'),
                }}
              />
            ) : (
              <EmptyState
                icon="wallet-outline"
                title={t('wallet.no_transactions')}
                description={t('wallet.no_transactions_first_desc', { defaultValue: 'Recargá tu billetera o pedí un viaje para ver movimientos acá.' })}
                action={{
                  label: t('wallet.recharge_cta', { defaultValue: 'Recargar saldo' }),
                  onPress: () => { triggerHaptic('light'); setRechargeSheetVisible(true); },
                }}
              />
            )
          }
        />
      </View>

      {/* Recharge BottomSheet */}
      <BottomSheet
        visible={rechargeSheetVisible}
        onClose={() => setRechargeSheetVisible(false)}
      >
        <View className="px-4 pb-6">
          <View style={{ alignItems: 'center', marginBottom: 12 }}>
            <Image source={tricoinStack} style={{ width: 80, height: 80 }} resizeMode="contain" />
          </View>
          <Text variant="h4" className="mb-4">{t('wallet.request_recharge')}</Text>
          <Text variant="bodySmall" color="secondary" className="mb-3">
            {t('wallet.recharge_amount_usd', { defaultValue: 'Monto (USD)' })}
          </Text>
          {/* Recharge preset amounts — USD denominated */}
          <View className="flex-row justify-between mb-3">
            {[20, 50, 100, 200].map((amount) => (
              <Pressable
                key={amount}
                onPress={() => setRechargeAmount(String(amount))}
                className={`flex-1 mx-1 py-2 rounded-full items-center ${
                  rechargeAmount === String(amount)
                    ? 'bg-primary-500'
                    : 'bg-neutral-100 dark:bg-neutral-800'
                }`}
              >
                <Text className={rechargeAmount === String(amount) ? 'text-white font-semibold' : 'text-neutral-700 dark:text-neutral-300'}>
                  ${amount}
                </Text>
              </Pressable>
            ))}
          </View>
          <Input
            placeholder="20"
            value={rechargeAmount}
            onChangeText={setRechargeAmount}
            keyboardType="numeric"
          />
          {(() => {
            // Wallet v2 PR 5: top-up preview (USD → fee → net TC → CUP).
            // Spec §10 #2: fee = 3% of charged USD, minimum $0.50.
            // Fall back to the spec rule when stripeConfig hasn't loaded.
            const usdNum = parseFloat(rechargeAmount);
            if (!Number.isFinite(usdNum) || usdNum <= 0) return null;
            const fee = stripeConfig?.feeUsd != null
              ? stripeConfig.feeUsd
              : Math.max(usdNum * 0.03, 0.50);
            const net = Math.max(0, usdNum - fee);
            const cupEq = Math.round(net * exchangeRate);
            const belowMin = usdNum < MIN_RECHARGE_USD;
            return (
              <View className="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="font-semibold" style={{ color: colors.brand.orange }}>
                  {t('wallet.recharge_preview_total', {
                    defaultValue: 'Recargás ${{usd}} USD = {{tc}} TriciCoin',
                    usd: usdNum.toFixed(2),
                    tc: net.toFixed(2),
                  })}
                </Text>
                <Text variant="caption" color="secondary" style={{ marginTop: 4 }}>
                  ≈ ${net.toFixed(2)} {t('wallet.recharge_preview_net', {
                    defaultValue: 'netos (después del 3% de comisión: -${{fee}})',
                    fee: fee.toFixed(2),
                  })}
                </Text>
                <Text variant="caption" color="secondary" style={{ marginTop: 2 }}>
                  {t('wallet.recharge_preview_cup', {
                    defaultValue: 'Equivale a {{cup}} CUP al cambio de hoy (1 USD = {{rate}} CUP)',
                    cup: cupEq.toLocaleString(),
                    rate: Math.round(exchangeRate).toLocaleString(),
                  })}
                </Text>
                {belowMin && (
                  <Text variant="caption" style={{ marginTop: 6, color: '#b45309', fontWeight: '600' }}>
                    {t('wallet.recharge_min_warning', {
                      defaultValue: 'Mínimo ${{min}} USD por recarga.',
                      min: MIN_RECHARGE_USD,
                    })}
                  </Text>
                )}
              </View>
            );
          })()}
          {!stripeReady && (
            <View className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 mb-3">
              <Text variant="caption" style={{ color: '#b45309' }}>
                {t('wallet.stripe_not_ready', {
                  defaultValue: 'Pagos con tarjeta desde la app — próximamente. Por ahora abrimos la versión web.',
                })}
              </Text>
            </View>
          )}
          <Button
            title={
              stripeReady
                ? t('wallet.pay_with_card', { defaultValue: 'Pagar con tarjeta' })
                : t('wallet.pay_with_card_web', { defaultValue: 'Abrir versión web' })
            }
            size="lg"
            fullWidth
            onPress={debouncedSubmitRecharge}
            loading={rechargeSubmitting}
            disabled={isProcessing || !rechargeAmount || parseFloat(rechargeAmount) < MIN_RECHARGE_USD}
          />
        </View>
      </BottomSheet>

      {/* Transfer BottomSheet */}
      <BottomSheet
        visible={transferSheetVisible}
        onClose={() => setTransferSheetVisible(false)}
      >
        <View className="px-4 pb-6">
          <Text variant="h4" className="mb-4">{t('wallet.transfer_title')}</Text>

          {/* Phone input + search */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_phone')}
          </Text>
          <View className="flex-row gap-2 mb-3">
            <View className="flex-1">
              <Input
                placeholder="+53 5XXXXXXX"
                value={transferPhone}
                onChangeText={(text: string) => {
                  setTransferPhone(text);
                  setTransferRecipient(null);
                }}
                keyboardType="phone-pad"
                className="mb-0"
              />
            </View>
            <Button
              title={t('search')}
              variant="outline"
              size="md"
              onPress={searchRecipient}
              loading={transferSearching}
              disabled={!isValidCubanPhone(transferPhone)}
            />
          </View>

          {/* Recipient info */}
          {transferRecipient && (
            <View className="bg-green-50 rounded-lg p-3 mb-3">
              <Text variant="bodySmall" color="primary">
                {t('wallet.transfer_to', { name: transferRecipient.full_name })}
              </Text>
            </View>
          )}

          {/* Amount */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_amount')} (CUP)
          </Text>
          <Input
            placeholder="100"
            value={transferAmount}
            onChangeText={setTransferAmount}
            keyboardType="numeric"
          />

          {/* Note */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_note')}
          </Text>
          <Input
            placeholder={t('wallet.transfer_note_hint', { defaultValue: 'Ej: Compartimos el viaje' })}
            value={transferNote}
            onChangeText={setTransferNote}
            maxLength={200}
          />

          <Text variant="caption" color="tertiary" className="mb-3 text-center">
            {t('wallet.balance')}: {formatTriciCoin(balance.available)}
          </Text>

          <Button
            title={t('wallet.transfer_confirm')}
            size="lg"
            fullWidth
            onPress={debouncedSubmitTransfer}
            loading={transferSubmitting}
            disabled={
              isProcessing ||
              !transferRecipient ||
              !transferAmount ||
              parseInt(transferAmount, 10) <= 0
            }
          />
        </View>
      </BottomSheet>

    </Screen>
  );
}

export default function WalletScreen() {
  if (Platform.OS === 'web') return <WebWalletScreen />;
  return <NativeWalletScreen />;
}
