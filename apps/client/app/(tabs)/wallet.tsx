import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, FlatList, ActivityIndicator, RefreshControl, Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { WalletMigrationBanner } from '@tricigo/ui/WalletMigrationBanner';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { paymentService } from '@tricigo/api/services/payment';
import {
  formatTriciCoin,
  formatTriciCoinUsd,
  formatCupApprox,
  formatUSD,
  trcToUsd,
  DEFAULT_EXCHANGE_RATE,
  getRelativeDay,
  triggerHaptic,
  triggerSelection,
  getErrorMessage,
  logger,
  computeRechargeFeeUsd,
  computeRechargeChargeUsd,
  RECHARGE_LIMITS,
  translateNetopiaError,
  signedLedgerAmountForAccount,
  classifyWalletTxn,
  walletTxnIcon,
} from '@tricigo/utils';
import type { LedgerTransaction, LedgerEntryType } from '@tricigo/types';
import Toast from 'react-native-toast-message';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useAuthStore } from '@/stores/auth.store';
import { useTokens } from '@/hooks/useTokens';
import { useThemeStore } from '@/stores/theme.store';
import { Input } from '@tricigo/ui/Input';
import { colors, darkColors } from '@tricigo/theme';
import { Platform, useColorScheme, Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { RIDE_CONFIG } from '@/config/ride';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

// Stripe SDK removed 2026-05-20 (NETOPIA cutover, see PROGRESS.md).
// Recharge now opens NETOPIA's hosted payment page inside an in-app
// browser via WebBrowser.openAuthSessionAsync (same pattern as OAuth
// login). NETOPIA redirects back to RETURN_URL_BASE + ?intent=<id>,
// the in-app browser closes, and we poll the intent status natively.
//
// RETURN_URL_BASE is a universal link first — Android/iOS will intercept
// it and route to this app if associated domains / intent filters are
// honored on tricigo.com (see app.json). If that linkage breaks, swap
// to the custom scheme 'tricigo://wallet'.
const RETURN_URL_BASE = 'https://tricigo.com/app/client/wallet';

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
 *
 *   P2P transfer filters ('transfer_in'/'transfer_out') were removed when
 *   the peer-to-peer transfer feature was retired (closed-loop ride
 *   credit). Legacy transfer ledger rows still render under "Todos" with
 *   their TYPE_LABELS label, but they no longer get a dedicated chip.
 */
type TxnFilter =
  | 'all'
  | 'recharge'
  | 'ride_payment'
  | 'bonus'
  | 'adjustment';

/** Human-readable i18n label from a classified transaction view (kind + direction). */
function getTransactionLabel(
  view: { kind: string; isCredit: boolean },
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (view.kind) {
    case 'recharge':
      return t('wallet.txn_recharge', { defaultValue: 'Recarga de saldo' });
    case 'ride':
      return view.isCredit
        ? t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' })
        : t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' });
    case 'commission':
      return t('wallet.txn_commission', { defaultValue: 'Comisión' });
    case 'gift':
    case 'transfer':
      return view.isCredit
        ? t('wallet.txn_gift_received', { defaultValue: 'Regalo recibido' })
        : t('wallet.txn_gift_sent', { defaultValue: 'Regalo enviado' });
    case 'tip':
      return view.isCredit
        ? t('wallet.txn_tip_received', { defaultValue: 'Propina recibida' })
        : t('wallet.txn_tip_sent', { defaultValue: 'Propina enviada' });
    case 'penalty':
      return t('wallet.txn_penalty', { defaultValue: 'Penalización por cancelación' });
    case 'bonus':
      return t('wallet.txn_bonus', { defaultValue: 'Bonificación' });
    case 'refund':
      return t('wallet.txn_refund', { defaultValue: 'Reembolso' });
    case 'adjustment':
    default:
      return t('wallet.txn_adjustment', { defaultValue: 'Ajuste' });
  }
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

  // Core wallet state — Wallet v2 phase 2: holds the legacy CUP-pegged
  // available/held PLUS the new USD-cents fields surfaced by the
  // 00242 migration. Old display path keeps reading available/held.
  const [balance, setBalance] = useState<{
    available: number;
    held: number;
    availableUsdCents: number | null;
    heldUsdCents: number | null;
    migrationRate: number | null;
    migrationBonusPct: number | null;
  }>({
    available: 0, held: 0,
    availableUsdCents: null, heldUsdCents: null,
    migrationRate: null, migrationBonusPct: null,
  });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<TxnFilter>('all');

  // Wallet v2 phase 2: dismissal state for the migration banner.
  // AsyncStorage falls back to localStorage on web automatically.
  const WEB_MIGRATION_BANNER_KEY = '@tricigo/wallet_v2_banner_dismissed';
  const [migrationBannerDismissed, setMigrationBannerDismissed] = useState(true);
  useEffect(() => {
    AsyncStorage.getItem(WEB_MIGRATION_BANNER_KEY).then((v) => {
      setMigrationBannerDismissed(v === '1');
    });
  }, []);
  const dismissWebMigrationBanner = useCallback(() => {
    setMigrationBannerDismissed(true);
    AsyncStorage.setItem(WEB_MIGRATION_BANNER_KEY, '1').catch(() => { /* best-effort */ });
  }, []);

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

  // Fetch wallet data.
  // ensureAccount is idempotent on the server side, balance/account
  // queries don't depend on it, and the exchange rate is fully
  // independent — they all batch into a single round-trip wave.
  // Only getTransactions blocks on account.id resolution from
  // getAccount, so we wait for the wave before issuing it.
  const fetchData = useCallback(async (resetTxns = true) => {
    if (!userId) return;
    try {
      const [, balanceData, account, rate] = await Promise.all([
        walletService.ensureAccount(userId),
        walletService.getBalance(userId),
        walletService.getAccount(userId),
        exchangeRateService.getUsdCupRate().catch(() => null),
      ]);
      setBalance(balanceData);
      setAccountId(account?.id ?? null);
      if (rate) setExchangeRate(rate);

      if (account?.id && resetTxns) {
        const txns = await walletService.getTransactions(account.id, 0, PAGE_SIZE);
        setTransactions(txns as TransactionWithAmount[]);
        setPage(0);
        setHasMore((txns as TransactionWithAmount[]).length >= PAGE_SIZE);
      }

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

  // Refetch whenever the Wallet tab regains focus. The common flow is
  // "user opens wallet/recharge or NETOPIA browser flow, completes
  // payment, taps back" — the wallet screen stays mounted in that case
  // and the [userId, fetchData] effect above does NOT re-run (fetchData
  // is a memoized callback whose deps don't change on focus). Without
  // this hook, the new recharge txn never appears in the Movimientos
  // list until the user pull-to-refreshes manually. Mirror of the
  // driver fix shipped in the same PR.
  useFocusEffect(
    useCallback(() => {
      if (userId) {
        fetchData();
      }
    }, [userId, fetchData])
  );

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
    { key: 'bonus', label: t('wallet.filter_bonus', { defaultValue: 'Bonos' }) },
    { key: 'adjustment', label: t('wallet.filter_adjustment', { defaultValue: 'Ajustes' }) },
  ];

  // Stripe recharge for web (Expo web uses redirect flow — native uses payment sheet below)
  const submitRecharge = useCallback(async () => {
    if (!userId) return;
    Toast.show({ type: 'info', text1: t('wallet.recharge_web_hint', { defaultValue: 'Usa la version web (tricigo.com/wallet) para recargar con tarjeta' }) });
  }, [t, userId]);

  // Login required
  if (!userId) {
    return (
      <Screen bg="cuban" padded>
        <View className="flex-1 justify-center items-center">
          <Text variant="body" color="secondary">{t('auth.login_required', { defaultValue: 'Inicia sesion para ver tus créditos de viaje' })}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="cuban" padded>
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="pt-4 pb-8">
          {/* ─── Balance Card ─── */}
          <View className="rounded-2xl p-5 mb-6" style={{ background: 'linear-gradient(135deg, #FF4D00, #FF8A5C)' } as any}>
            <View className="flex-row items-center gap-2.5 mb-3">
              <Image source={tricoinLogo} style={{ width: 40, height: 40 }} resizeMode="contain" />
              <Text variant="h4" className="font-semibold" style={{ color: '#fff' }}>{t('wallet.title', { defaultValue: 'Créditos TriciGo' })}</Text>
            </View>
            <Text variant="caption" className="mb-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
              {t('wallet.available_balance', { defaultValue: 'Saldo disponible' })}
            </Text>
            {/* Closed-loop ride credit: the primary balance is shown in
                credit units (formatTriciCoin), never as a USD amount. */}
            <View className="flex-row items-center gap-2 mb-1">
              <Image source={tricoinSmall} style={{ width: 28, height: 28 }} resizeMode="contain" />
              <Text variant="h2" className="font-bold" style={{ color: '#fff' }}>
                {loading ? '...' : formatTriciCoin(balance.available)}
              </Text>
            </View>
            {balance.held > 0 && (
              <Text variant="caption" className="mt-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {t('wallet.held_balance', { defaultValue: 'En retencion' })}: {formatTriciCoin(balance.held)}
              </Text>
            )}
          </View>

          {/* Wallet v2 phase 2: one-time migration announcement on web. */}
          {!migrationBannerDismissed && balance.availableUsdCents != null && (
            <WalletMigrationBanner
              balanceUsdCents={balance.availableUsdCents}
              bonusPct={balance.migrationBonusPct ?? 0}
              onDismiss={dismissWebMigrationBanner}
            />
          )}

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
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  className={`px-4 py-2 rounded-full border ${
                    activeFilter === opt.key
                      ? 'bg-primary-500 border-primary-500'
                      : 'bg-neutral-50 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
                  }`}
                  accessibilityRole="radio"
                  accessibilityLabel={opt.label}
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
                description={t('wallet.no_transactions_first_desc', { defaultValue: 'Pedí un viaje para ver tus movimientos acá.' })}
                action={{
                  label: t('wallet.request_ride_cta', { defaultValue: 'Pedí tu primer viaje' }),
                  onPress: () => router.push('/(tabs)'),
                }}
              />
            )
          ) : (
            <View className="mb-6">
              {filteredTransactions.map((tx) => {
                // Net effect on THIS account. A ledger transaction can touch
                // multiple accounts (a gift debits the sender + credits the
                // recipient) — and admins see both entries via is_admin() RLS
                // bypass. Reading [0] blindly + formatTriciCoin's Math.max(0,…)
                // clamp made every debit render "0 TC". Sum this account's
                // entries (driver parity, PR #447).
                const view = classifyWalletTxn(tx, accountId);
                const { signedAmount, isCredit } = view;
                // Wallet v2 phase 2: USD-equivalent caption per txn using
                // the wallet's stamped migration_rate (provides a stable
                // bridge from historical CUP-pegged amounts to the new
                // unit-of-account without rewriting historical data).
                const rateForTxn = balance.migrationRate ?? exchangeRate;
                const usdEq = trcToUsd(Math.abs(signedAmount), rateForTxn);
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
                          {getTransactionLabel(view, t)}
                        </Text>
                        {tx.description ? (
                          <Text variant="caption" color="tertiary" numberOfLines={1}>{tx.description}</Text>
                        ) : null}
                        <Text variant="caption" color="tertiary">{getRelativeDay(tx.created_at, t('today'), t('yesterday'))}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text
                          variant="body"
                          className={`font-semibold ${isCredit ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
                          style={{ fontVariant: ['tabular-nums'] }}
                        >
                          {view.isZero ? '' : isCredit ? '+' : '−'}{formatTriciCoin(Math.abs(signedAmount))}
                        </Text>
                        {balance.availableUsdCents != null && (
                          <Text variant="caption" color="tertiary" style={{ fontVariant: ['tabular-nums'] }}>
                            ≈ {isCredit ? '+' : '-'}{formatUSD(usdEq)}
                          </Text>
                        )}
                      </View>
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
              {t('wallet.recharge_title', { defaultValue: 'Comprar créditos de viaje' })}
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
            <Button
              title={t('wallet.gift', { defaultValue: 'Regalar' })}
              size="lg"
              fullWidth
              onPress={() => router.push('/wallet/gift')}
              variant="primary"
              className="mt-3"
            />
          </View>

        </View>
      </ScrollView>

    </Screen>
  );
}

function NativeWalletScreen() {
  const { t } = useTranslation('common');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const tokens = useTokens();
  const userId = useAuthStore((s) => s.user?.id);

  // Cuban Modern premium shadows (mirror driver wallet). Orange-tinted on the
  // hero + CTA to reinforce brand; neutral on transaction cards.
  const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };
  const HERO_SHADOW = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.28 : 0.16,
    shadowRadius: 24,
    elevation: 12,
  };
  const GLOW_CTA = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  };
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };

  // Transaction icon comes from the shared walletTxnIcon(view) helper.

  const [balance, setBalance] = useState<{
    available: number;
    held: number;
    availableUsdCents: number | null;
    heldUsdCents: number | null;
    migrationRate: number | null;
    migrationBonusPct: number | null;
  }>({
    available: 0, held: 0,
    availableUsdCents: null, heldUsdCents: null,
    migrationRate: null, migrationBonusPct: null,
  });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<TxnFilter>('all');

  // Wallet v2 phase 2: dismissal state for the migration banner.
  const MIGRATION_BANNER_KEY = '@tricigo/wallet_v2_banner_dismissed';
  const [migrationBannerDismissed, setMigrationBannerDismissed] = useState(true); // default true to avoid flash
  useEffect(() => {
    AsyncStorage.getItem(MIGRATION_BANNER_KEY).then((v) => {
      setMigrationBannerDismissed(v === '1');
    });
  }, []);
  const dismissMigrationBanner = useCallback(() => {
    setMigrationBannerDismissed(true);
    AsyncStorage.setItem(MIGRATION_BANNER_KEY, '1').catch(() => { /* best-effort */ });
  }, []);

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

  // Processing guard to prevent double-submit across all wallet actions
  const [isProcessing, setIsProcessing] = useState(false);

  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);

  // Wallet v2 PR 4: receipt index by payment_intent_id.
  const [receiptByPiId, setReceiptByPiId] = useState<Map<string, { receipt_no: string; pdf_storage_path: string | null }>>(new Map());
  const [openingReceipt, setOpeningReceipt] = useState<string | null>(null);

  // Fetch wallet data.
  // ensureAccount, balance, account, exchange rate have no dependencies
  // on each other — batch them into one wave. Only getTransactions
  // blocks on account.id, so it runs after.
  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const [, balanceData, account, rate] = await Promise.all([
        walletService.ensureAccount(userId),
        walletService.getBalance(userId),
        walletService.getAccount(userId),
        exchangeRateService.getUsdCupRate().catch(() => null),
      ]);
      setBalance(balanceData);
      setAccountId(account?.id ?? null);
      if (rate) setExchangeRate(rate);

      if (account?.id) {
        const txns = await walletService.getTransactions(account.id, 0, 20);
        setTransactions(txns as TransactionWithAmount[]);
      }

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

  // RECARGA V2 limits — sourced from @tricigo/utils so client + server
  // (create-netopia-payment-intent EF) read from the same constants.
  const MIN_RECHARGE_USD = RECHARGE_LIMITS.customer.min;
  const MAX_RECHARGE_USD = RECHARGE_LIMITS.customer.max;

  // Wallet v2 PR 4: native receipt opener uses Linking.openURL (web build
  // never reaches NativeWalletScreen, so window.open is not needed here).
  // Declared BEFORE submitRecharge so the latter can pass it as a deps
  // (the success-step poll Toast uses it as the onPress handler).
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

  // Post-2026-05-20 cutover: mobile recharge opens the web wallet,
  // where NETOPIA's hosted payment page runs. The native Stripe
  // PaymentSheet path was removed because (a) NETOPIA does not ship
  // a native SDK equivalent and (b) hosted-page redirect is the only
  // flow the merchant POS supports. The native app keeps the bottom
  // sheet for amount entry but hands off to the browser for the
  // actual payment step.
  const submitRecharge = useCallback(async () => {
    if (!userId) return;
    const usd = parseFloat(rechargeAmount);
    if (!usd || isNaN(usd) || usd < MIN_RECHARGE_USD || usd > MAX_RECHARGE_USD) {
      Toast.show({
        type: 'error',
        text1: t('wallet.invalid_amount', { defaultValue: 'Monto inválido' }),
      });
      return;
    }

    setRechargeSheetVisible(false);
    setIsProcessing(true);
    setRechargeSubmitting(true);
    try {
      // RECARGA V2: pass the NET USD amount. The edge function computes
      // the additive fee (3% min $0.50) and tells NETOPIA the full
      // charge. The wallet gets credited with `amountUsd × FX` in CUP.
      const result = await paymentService.createRechargeIntent({
        provider: 'netopia',
        userId,
        amountUsd: usd,
        returnUrl: RETURN_URL_BASE,
      });
      if (!result.redirectUrl) {
        throw new Error(t('wallet.recharge_no_url', { defaultValue: 'El procesador no devolvió URL de pago' }));
      }

      // 2. Open the hosted page in an in-app browser. Bloquea hasta que
      //    NETOPIA redirija al dismissUrl (= nuestro returnUrl + ?intent=<id>),
      //    momento en que el sistema cierra el browser y nos devuelve aquí.
      const dismissUrl = `${RETURN_URL_BASE}?intent=${result.intentId}`;
      await WebBrowser.openAuthSessionAsync(
        result.redirectUrl,
        dismissUrl,
      );

      // 3. ALWAYS poll the intent — browser dismissal type is NOT a
      //    reliable success/cancel signal. If the universal link fails
      //    to open the app, the user closes the browser manually and
      //    we get `dismiss`/`cancel` even though NETOPIA already
      //    processed the IPN. The DB is the source of truth.
      //    (Same fix as driver in apps/driver/app/wallet/recharge.tsx.)
      Toast.show({
        type: 'info',
        text1: t('wallet.processing_recharge', { defaultValue: 'Verificando tu pago…' }),
      });
      const final = await paymentService.pollIntentStatus(result.intentId, 20, 2000);
      if (final.status === 'completed') {
        Toast.show({
          type: 'success',
          text1: t('wallet.recharge_success', { defaultValue: '¡Recarga exitosa!' }),
          text2: `+${result.amountCupCredited.toLocaleString()} TC`,
        });
        await fetchData();
        // RECARGA V2 PARITY: the receipt PDF is generated async by the
        // webhook (~5-10s after the intent settles). Poll wallet_receipts
        // for up to ~12s; once we see the row, splice it into the inline
        // map (so the historial row immediately gets its download button)
        // and surface a tappable Toast so the user can open the PDF in
        // one tap without scrolling to the new txn.
        void (async () => {
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const receipts = await walletService.getReceipts(userId, 5);
              const found = receipts.find(
                (r) => r.payment_intent_id === result.intentId && r.pdf_storage_path,
              );
              if (found?.pdf_storage_path) {
                setReceiptByPiId((prev) => {
                  const next = new Map(prev);
                  next.set(found.payment_intent_id, {
                    receipt_no: found.receipt_no,
                    pdf_storage_path: found.pdf_storage_path,
                  });
                  return next;
                });
                Toast.show({
                  type: 'success',
                  text1: t('wallet.recharge_receipt_ready', {
                    defaultValue: 'Comprobante listo',
                  }),
                  text2: t('wallet.tap_to_view_receipt', {
                    defaultValue: 'Tocá para ver el PDF',
                  }),
                  onPress: () => openReceiptNative(found.pdf_storage_path!, found.receipt_no),
                  visibilityTime: 8000,
                });
                return;
              }
            } catch {
              /* Non-fatal: user can still download from the txn list. */
            }
          }
        })();
      } else if (final.status === 'failed') {
        // Translate NETOPIA's English raw message (e.g. "Invalid CVV")
        // into Spanish copy that always tells the user their card was
        // NOT charged. See packages/utils/src/netopia-errors.ts.
        Toast.show({
          type: 'error',
          text1: t('wallet.recharge_failed', { defaultValue: 'El pago no se completó' }),
          text2: translateNetopiaError(final.error_message),
        });
      } else {
        // status='pending' / 'created' / 'processing' — webhook still in
        // flight (or user closed the browser before paying). Push notif
        // covers the final outcome; show a soft "verifying" with hint.
        Toast.show({
          type: 'info',
          text1: t('wallet.recharge_pending', { defaultValue: 'Verificando tu pago…' }),
          text2: t('wallet.recharge_pending_hint', {
            defaultValue: 'Te avisaremos por notificación cuando termine.',
          }),
        });
      }
    } catch (err) {
      logger.error('netopia_recharge_failed', { error: String(err) });
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
    } finally {
      setRechargeSubmitting(false);
      setIsProcessing(false);
    }
  }, [userId, rechargeAmount, exchangeRate, t, fetchData, openReceiptNative, MAX_RECHARGE_USD, MIN_RECHARGE_USD]);
  const debouncedSubmitRecharge = useDebouncePress(submitRecharge);

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
      const amount = signedLedgerAmountForAccount(tx.ledger_entries, accountId);
      return amount < 0;
    });

    const totalSpent = monthRideDebits.reduce((sum, tx) => {
      const amount = signedLedgerAmountForAccount(tx.ledger_entries, accountId);
      return sum + Math.abs(amount);
    }, 0);
    const ridesCount = monthRideDebits.length;
    const avgRide = ridesCount > 0 ? Math.round(totalSpent / ridesCount) : 0;

    return { totalSpent, ridesCount, avgRide };
  }, [transactions, accountId]);

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
    { key: 'bonus', label: t('wallet.filter_bonus', { defaultValue: 'Bonos' }) },
    { key: 'adjustment', label: t('wallet.filter_adjustment', { defaultValue: 'Ajustes' }) },
  ];

  const renderTransaction = ({ item, index }: { item: TransactionWithAmount; index: number }) => {
    // Net effect on THIS account (driver parity, PR #447). Reading [0] blindly
    // + formatTriciCoin's Math.max(0,…) clamp rendered every debit as "0 TC".
    const view = classifyWalletTxn(item, accountId);
    const { signedAmount, isCredit } = view;
    // Wallet v2 phase 2: USD-equivalent caption per txn (uses the
    // wallet's stamped migration_rate as a stable bridge from
    // historical CUP-pegged amounts to the new unit-of-account).
    const rateForTxn = balance.migrationRate ?? exchangeRate;
    const usdEq = trcToUsd(Math.abs(signedAmount), rateForTxn);
    // Wallet v2 PR 4: only Stripe recharges (reference_type='payment_intent') get receipts.
    const receipt = item.type === 'recharge' && item.reference_type === 'payment_intent' && item.reference_id
      ? receiptByPiId.get(item.reference_id)
      : null;
    const canDownload = !!receipt?.pdf_storage_path;
    const txColor = isCredit ? (isDark ? '#4ADE80' : '#16A34A') : (isDark ? '#F87171' : '#DC2626');
    return (
      <AnimatedCard delay={Math.min(index * 60, 300)}>
        {/* Elevated transaction card (driver parity): icon-box by type, amount
            + optional USD caption right-aligned, receipt pill below. */}
        <View
          style={{
            marginBottom: 8,
            backgroundColor: tokens.bg.elev1,
            borderRadius: 14,
            ...CARD_SHADOW,
          }}
          accessible={true}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 14 }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                backgroundColor: `${txColor}1A`,
                alignItems: 'center',
                justifyContent: 'center',
                marginRight: 12,
              }}
            >
              <Ionicons name={walletTxnIcon(view) as keyof typeof Ionicons.glyphMap} size={18} color={txColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={{ color: tokens.ink.primary, fontWeight: '600', fontSize: 14 }}
              >
                {item.description || getTransactionLabel(view, t)}
              </Text>
              <Text style={{ color: tokens.ink.secondary, fontSize: 12, marginTop: 2 }}>
                {getRelativeDay(item.created_at, t('today'), t('yesterday'))}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: txColor, fontWeight: '700', fontSize: 15, ...TABULAR }}>
                {view.isZero ? '' : isCredit ? '+' : '−'}{formatTriciCoin(Math.abs(signedAmount))}
              </Text>
              {balance.availableUsdCents != null && (
                <Text style={{ color: tokens.ink.subtle, fontSize: 11, marginTop: 2, ...TABULAR }}>
                  ≈ {isCredit ? '+' : '-'}{formatUSD(usdEq)}
                </Text>
              )}
            </View>
          </View>
          {canDownload && receipt && (
            <Pressable
              onPress={() => openReceiptNative(receipt.pdf_storage_path!, receipt.receipt_no)}
              disabled={openingReceipt === receipt.receipt_no}
              style={({ pressed }) => [
                { paddingHorizontal: 14, paddingBottom: 12, marginTop: -4 },
                pressed && { opacity: 0.65 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('wallet.download_receipt_aria', { defaultValue: 'Descargar comprobante {{no}}', no: receipt.receipt_no })}
            >
              <View
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: tokens.accent.warm,
                  borderRadius: 9999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  marginLeft: 52,
                }}
              >
                <Ionicons
                  name={openingReceipt === receipt.receipt_no ? 'hourglass-outline' : 'document-text-outline'}
                  size={11}
                  color="#FFFFFF"
                  style={{ marginRight: 4 }}
                />
                <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>
                  {openingReceipt === receipt.receipt_no
                    ? t('wallet.opening_receipt', { defaultValue: 'Abriendo…' })
                    : `${t('wallet.download_receipt', { defaultValue: 'Comprobante' })} ${receipt.receipt_no}`}
                </Text>
              </View>
            </Pressable>
          )}
        </View>
      </AnimatedCard>
    );
  };

  if (loading) {
    return (
      <Screen bg="cuban" padded>
        <View className="pt-4 flex-1" style={{ backgroundColor: tokens.bg.paper }}>
          {/* Final-shape skeletons (driver parity): hero + CTA + tx rows. */}
          <View style={{ height: 160, borderRadius: 24, backgroundColor: tokens.bg.elev1, marginBottom: 16, ...HERO_SHADOW }} />
          <View style={{ height: 60, borderRadius: 20, backgroundColor: tokens.bg.elev1, marginBottom: 12, opacity: 0.6 }} />
          <View style={{ height: 48, borderRadius: 16, backgroundColor: tokens.bg.elev1, marginBottom: 24, opacity: 0.5 }} />
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={{ height: 72, borderRadius: 14, backgroundColor: tokens.bg.elev1, marginBottom: 8, opacity: 1 - i * 0.12, ...CARD_SHADOW }}
            />
          ))}
        </View>
      </Screen>
    );
  }

  // Hero balance display — replicate BalanceBadge's USD/legacy logic so the
  // hand-rolled premium hero shows the same figures (no display regression).
  const heroRate = balance.migrationRate ?? exchangeRate;
  const heroUsdMode = balance.availableUsdCents != null && balance.availableUsdCents > 0;
  const heroPrimary = heroUsdMode
    ? formatTriciCoinUsd(balance.availableUsdCents ?? 0)
    : formatTriciCoin(displayBalance);
  const heroSubtitle = heroUsdMode
    ? formatCupApprox(balance.availableUsdCents ?? 0, heroRate)
    : `≈ ${formatUSD(trcToUsd(displayBalance, heroRate))}`;
  const heroHasHeld = heroUsdMode ? (balance.heldUsdCents ?? 0) > 0 : balance.held > 0;
  const heroHeldText = heroUsdMode
    ? formatTriciCoinUsd(balance.heldUsdCents ?? 0)
    : formatTriciCoin(balance.held);

  return (
    <Screen bg="cuban" padded>
      {/* Home-style layout: compact iOS-native header (h4 instead of
          large display), no big icon hero. The demo banner (~46px in
          demo builds) is non-blocking via SafeAreaView; no extra
          padding hack needed. */}
      <View
        className="pt-4 flex-1"
        style={{ backgroundColor: tokens.bg.paper }}
      >
        {/* iOS-style small title row — Inter h4 (20pt), aligned with the
            "RECIENTES" / "SERVICIOS" mono labels of the home. */}
        <View className="flex-row items-center justify-between mb-4">
          <View className="flex-row items-center gap-2">
            <Image source={tricoinLogo} style={{ width: 26, height: 26 }} resizeMode="contain" />
            <Text style={{ color: tokens.ink.primary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
              {t('wallet.title', { defaultValue: 'Créditos TriciGo' })}
            </Text>
          </View>
        </View>

        {/* Wallet v2 phase 2: one-time migration announcement (dismissible). */}
        {!migrationBannerDismissed && balance.availableUsdCents != null && (
          <WalletMigrationBanner
            balanceUsdCents={balance.availableUsdCents}
            bonusPct={balance.migrationBonusPct ?? 0}
            onDismiss={dismissMigrationBanner}
          />
        )}

        {/* Premium hero — 3-layer (gradient base + orange glow + content) with
            orange-tinted shadow, mirroring the driver wallet. Replaces the flat
            balance card. heroPrimary/heroSubtitle replicate BalanceBadge's
            USD/legacy display so there's no figure regression. */}
        <AnimatedCard delay={0}>
          <View style={{ borderRadius: 24, marginBottom: 16, ...HERO_SHADOW }}>
            <View style={{ borderRadius: 24, overflow: 'hidden' }}>
              <LinearGradient
                colors={isDark ? ['#11172A', '#18203A'] : ['#FFFFFF', '#FFFBF5']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFillObject}
              />
              <LinearGradient
                colors={[tokens.accent.orangeGlow, 'transparent']}
                start={{ x: 1, y: 0 }}
                end={{ x: 0.3, y: 0.7 }}
                style={{ position: 'absolute', top: 0, right: 0, width: 180, height: 180 }}
                pointerEvents="none"
              />
              <View style={{ padding: 24 }}>
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    letterSpacing: 1.6,
                    color: tokens.ink.secondary,
                    textTransform: 'uppercase',
                    marginBottom: 10,
                  }}
                >
                  {t('wallet.balance_label', { defaultValue: 'SALDO DISPONIBLE' })}
                </Text>
                <Text
                  style={{
                    fontFamily: 'Montserrat_800ExtraBold',
                    fontSize: 42,
                    letterSpacing: -1.2,
                    lineHeight: 48,
                    color: tokens.ink.primary,
                    ...TABULAR,
                  }}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {heroPrimary}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                  <View
                    style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.accent.warm, marginRight: 8 }}
                  />
                  <Text style={{ fontSize: 15, fontWeight: '600', color: tokens.accent.warm, ...TABULAR }}>
                    {heroSubtitle}
                  </Text>
                </View>
                {heroHasHeld && (
                  <View
                    style={{
                      marginTop: 16,
                      alignSelf: 'flex-start',
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: tokens.accent.orangeGlow,
                      borderRadius: 9999,
                      paddingHorizontal: 12,
                      paddingVertical: 5,
                    }}
                  >
                    <Ionicons name="lock-closed" size={11} color={tokens.accent.orange} style={{ marginRight: 5 }} />
                    <Text style={{ color: tokens.accent.orange, fontSize: 12, fontWeight: '700', ...TABULAR }}>
                      {t('wallet.held', { defaultValue: 'Retenido' })}: {heroHeldText}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </AnimatedCard>

        {/* Premium CTA — glow gradient Recargar (driver parity) + outlined
            Regalar below. Gift is closed-loop: TriciCoin can be sent to another
            active TriciGo user but stays spend-only (rides), never cashed out. */}
        <Pressable
          onPress={handleRecharge}
          accessibilityRole="button"
          accessibilityLabel={t('wallet.recharge')}
          style={({ pressed }) => [
            { borderRadius: 20, overflow: 'hidden', marginBottom: 12, ...GLOW_CTA },
            pressed && { transform: [{ scale: 0.97 }], opacity: 0.95 },
          ]}
        >
          <LinearGradient
            colors={[colors.brand.orange, tokens.accent.warm]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 18,
              paddingHorizontal: 24,
              minHeight: 60,
            }}
          >
            <Ionicons name="add-circle" size={24} color="#FFFFFF" />
            <Text style={{ color: '#FFFFFF', fontFamily: 'Montserrat_700Bold', fontSize: 17, marginLeft: 10, letterSpacing: 0.3 }}>
              {t('wallet.recharge')}
            </Text>
            <Ionicons name="chevron-forward" size={18} color="#FFFFFF" style={{ marginLeft: 8, opacity: 0.85 }} />
          </LinearGradient>
        </Pressable>

        <Pressable
          onPress={() => router.push('/wallet/gift')}
          accessibilityRole="button"
          accessibilityLabel={t('wallet.gift', { defaultValue: 'Regalar' })}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 14,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: tokens.line,
              backgroundColor: tokens.bg.elev1,
              marginBottom: 24,
            },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Ionicons name="gift-outline" size={20} color={tokens.accent.orange} />
          <Text style={{ color: tokens.ink.primary, fontFamily: 'Montserrat_700Bold', fontSize: 15, marginLeft: 10 }}>
            {t('wallet.gift', { defaultValue: 'Regalar' })}
          </Text>
        </Pressable>

        {/* BUG-280 — "Este mes" now hides when there are no rides this month
            (previously showed "70,000 TC gastado / 0 viajes" because admin
            adjustments and ride_holds counted as spending). Always-on stats
            cards are visually noisy when there's nothing to show. */}
        {monthlyInsights.ridesCount > 0 && (
          <View className="mb-6">
            <Text
              variant="captionMono"
              style={{ color: tokens.ink.subtle, marginBottom: 8 }}
            >
              {t('wallet.this_month', { defaultValue: 'ESTE MES' })}
            </Text>
            <View className="flex-row gap-3">
              {[
                { label: t('wallet.total_spent', { defaultValue: 'Total gastado' }), value: formatTriciCoin(monthlyInsights.totalSpent) },
                { label: t('wallet.rides_count', { defaultValue: 'Viajes' }), value: String(monthlyInsights.ridesCount) },
                { label: t('wallet.avg_ride', { defaultValue: 'Promedio' }), value: formatTriciCoin(monthlyInsights.avgRide) },
              ].map((stat) => (
                <View
                  key={stat.label}
                  style={{
                    flex: 1,
                    backgroundColor: tokens.bg.elev1,
                    borderRadius: 16,
                    padding: 16,
                    ...CARD_SHADOW,
                  }}
                >
                  <Text
                    variant="captionMono"
                    style={{ color: tokens.ink.secondary, marginBottom: 6 }}
                  >
                    {stat.label}
                  </Text>
                  <Text
                    variant="numberMono"
                    style={{ color: tokens.accent.orange, fontWeight: '600', fontSize: 17 }}
                  >
                    {stat.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
          <Text style={{ color: tokens.ink.primary, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 }}>
            {t('wallet.history', { defaultValue: 'Historial' })}
          </Text>
          <View style={{ flex: 1, height: 1, backgroundColor: tokens.line, marginLeft: 12 }} />
        </View>

        {/* Filter chips — clean implementation that doesn't fight the
            parent layout. Wrapping the ScrollView in a fixed-height
            container is enough to prevent the FlatList sibling from
            stretching it; no `items-start` / `self-start` / maxHeight
            hacks needed. Each chip gets a fixed minHeight so the row
            looks uniform regardless of which one is active. */}
        <View style={{ height: 40, marginBottom: 12 }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingRight: 16, alignItems: 'center' }}
          >
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              {filterOptions.map((opt) => (
                <Pressable
                  key={opt.key}
                  onPress={() => { triggerSelection(); setActiveFilter(opt.key); }}
                  // HIG fix — extend the tap area on all 4 sides so the
                  // 36pt-tall chip becomes a 48pt+ effective target.
                  hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                  style={{
                    height: 36,
                    paddingHorizontal: 16,
                    borderRadius: 999,
                    borderWidth: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      activeFilter === opt.key
                        ? tokens.accent.orange
                        : tokens.bg.elev1,
                    borderColor:
                      activeFilter === opt.key
                        ? tokens.accent.orange
                        : tokens.line,
                  }}
                  accessibilityRole="radio"
                  // a11y fix — VoiceOver was just announcing "radio button,
                  // selected/not selected" without distinguishing chips.
                  // Now each chip says its label ("Todos", "Recargas", etc.).
                  accessibilityLabel={opt.label}
                  accessibilityState={{ selected: activeFilter === opt.key }}
                >
                  <Text
                    variant="caption"
                    style={{
                      fontWeight: '500',
                      color:
                        activeFilter === opt.key
                          ? '#FFFFFF'
                          : tokens.ink.secondary,
                    }}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>

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
                description={t('wallet.no_transactions_first_desc', { defaultValue: 'Comprá créditos de viaje o pedí un viaje para ver movimientos acá.' })}
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
            // RECARGA V2 preview — additive fee model.
            //   User picks NET USD ($X). Fee = MAX($X * 3%, $0.50) is
            //   added on top. The card is charged $X + fee. The wallet
            //   is credited with X × FX (in CUP). One source of truth
            //   for the math: @tricigo/utils → computeRecharge*Usd.
            const usdNum = parseFloat(rechargeAmount);
            if (!Number.isFinite(usdNum) || usdNum <= 0) return null;
            const fee = computeRechargeFeeUsd(usdNum);
            const charge = computeRechargeChargeUsd(usdNum);
            const cupCredited = Math.round(usdNum * exchangeRate);
            const belowMin = usdNum < MIN_RECHARGE_USD;
            return (
              <View className="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="font-semibold" style={{ color: colors.brand.orange }}>
                  {t('wallet.recharge_preview_charge', {
                    defaultValue: 'Pagás ${{charge}} USD (incluye ${{fee}} de comisión)',
                    charge: charge.toFixed(2),
                    fee: fee.toFixed(2),
                  })}
                </Text>
                <Text variant="caption" color="secondary" style={{ marginTop: 4 }}>
                  {t('wallet.recharge_preview_credit', {
                    defaultValue: 'Acreditás {{cup}} TriciCoin (≈ {{cup}} CUP al cambio de hoy: {{rate}} CUP/USD)',
                    cup: cupCredited.toLocaleString(),
                    rate: Math.round(exchangeRate).toLocaleString(),
                  })}
                </Text>
                {belowMin && (
                  <Text variant="caption" style={{ marginTop: 6, color: isDark ? '#fbbf24' : '#b45309', fontWeight: '600' }}>
                    {t('wallet.recharge_min_warning', {
                      defaultValue: 'Mínimo ${{min}} USD por recarga.',
                      min: MIN_RECHARGE_USD,
                    })}
                  </Text>
                )}
              </View>
            );
          })()}
          {/* Post-NETOPIA cutover: the banner is now always shown — the
              recharge flow always uses NETOPIA's in-app browser. The
              dark-mode color tip (isDark ? amber-300 : amber-700) was
              imported from PR #138's resolution of the previous Stripe
              version. */}
          <View className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 mb-3">
            <Text variant="caption" style={{ color: isDark ? '#fbbf24' : '#b45309' }}>
              {t('wallet.recharge_inapp_hint', {
                defaultValue: 'Pagás con tarjeta de forma segura sin salir de la app.',
              })}
            </Text>
          </View>
          {/* Apple Guideline 3.1.1 defense: explicit disclaimer that wallet
              credit redeems only for physical transportation services. This
              keeps the wallet outside the "digital goods → IAP" requirement. */}
          <Text variant="caption" color="tertiary" className="mb-3 text-center">
            {t('wallet.physical_service_disclaimer', {
              defaultValue: 'El saldo se canjea exclusivamente por viajes físicos. No desbloquea contenido digital ni funciones premium dentro de la app.',
            })}
          </Text>
          <Button
            title={t('wallet.pay_with_card', { defaultValue: 'Pagar con tarjeta' })}
            size="lg"
            fullWidth
            onPress={debouncedSubmitRecharge}
            loading={rechargeSubmitting}
            disabled={isProcessing || !rechargeAmount || parseFloat(rechargeAmount) < MIN_RECHARGE_USD}
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
