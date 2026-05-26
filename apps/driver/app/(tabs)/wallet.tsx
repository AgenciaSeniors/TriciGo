// ============================================================
// Sub-PR E: Consolidación pantalla Wallet driver
//
// User pidió: "en el driver cuando entrar a wallet sale todo en 0".
// Root cause: la subpantalla `apps/driver/app/wallet/index.tsx` (a la
// que linkeaba el botón "Ver Wallet" desde Ganancias) seguía leyendo
// driver_cash en lugar de tricicoin → todo en 0 para Eduardo Admin.
//
// Decisión: consolidar TODO en este tab. La subscreen se elimina.
// El tab muestra: balance principal + Total ganado/gastado + lista
// paginada de transacciones (con descarga de comprobantes para
// recargas NETOPIA). Sin QuotaCard "Crédito de comisión", sin metas
// Daily/Weekly/Monthly, sin historial filtered redundante.
//
// Todas las queries usan account_type='tricicoin' (single-wallet
// model post-00300).
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Pressable, RefreshControl, ActivityIndicator, Alert, Linking, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatCard } from '@tricigo/ui/StatCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonBalance, SkeletonCard } from '@tricigo/ui/Skeleton';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { formatCUP, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE, generateWalletCSV } from '@tricigo/utils';
import { colors, driverStandardLightColors, driverDarkColors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import type { LedgerTransaction, WalletSummary } from '@tricigo/types';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

const PAGE_SIZE = 20;

export default function WalletScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);
  // 00324: dark mode support — driver app respects device theme. Picks between
  // driverStandardLightColors (default) and driverDarkColors based on system.
  // Both palettes share the same shape (text.{primary,secondary,tertiary},
  // background.tertiary, card), so call sites need no further branching.
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const lt = isDark ? driverDarkColors : driverStandardLightColors;
  const CARD_SHADOW = {
    shadowColor: isDark ? '#FFF' : '#000',
    shadowOpacity: isDark ? 0.06 : 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  };

  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  // RECARGA V2 PARITY: map payment_intent_id → receipt metadata so we
  // can render a "Descargar comprobante" button on each tricicoin
  // recharge txn. Portado de wallet/index.tsx (BUG-Wallet-Consolidate).
  const [receiptByPiId, setReceiptByPiId] = useState<Map<string, {
    receipt_no: string;
    pdf_storage_path: string | null;
  }>>(new Map());
  const [openingReceipt, setOpeningReceipt] = useState<string | null>(null);

  const fetchData = useCallback(async (reset = false) => {
    if (!userId) return;
    try {
      const p = reset ? 0 : page;
      // 00300: single-wallet driver model → tricicoin es la única fuente
      // de verdad para el balance + transacciones del driver.
      const [summaryData, rateData] = await Promise.all([
        walletService.getSummary(userId, 'tricicoin'),
        exchangeRateService.getUsdCupRate().catch(() => DEFAULT_EXCHANGE_RATE),
      ]);
      setSummary(summaryData);
      setExchangeRate(rateData);

      let txData: LedgerTransaction[] = [];
      if (summaryData.account_id) {
        txData = await walletService.getTransactions(summaryData.account_id, p, PAGE_SIZE);
      }

      if (reset) {
        setTransactions(txData);
        setPage(1);
      } else {
        setTransactions((prev) => [...prev, ...txData]);
        setPage((prev) => prev + 1);
      }
      setHasMore(txData.length === PAGE_SIZE);

      // RECARGA V2 PARITY: load wallet receipts so each `recharge` txn
      // with matching payment_intent_id surfaces a download button.
      // Best-effort — UI hides receipts silently if this fails.
      if (reset) {
        try {
          const receipts = await walletService.getReceipts(userId, 100);
          const map = new Map<string, { receipt_no: string; pdf_storage_path: string | null }>();
          for (const r of receipts) {
            map.set(r.payment_intent_id, {
              receipt_no: r.receipt_no,
              pdf_storage_path: r.pdf_storage_path,
            });
          }
          setReceiptByPiId(map);
        } catch {
          // Non-fatal: txn rows just won't have a download button.
        }
      }
    } catch (err) {
      // 00324: surface the error via Toast so we catch RPC regressions early
      // (we just lost a critical week of "everyone sees 0" due to the silent
      // catch swallowing an ambiguous-column exception from get_wallet_summary).
      console.error('[Wallet] fetchData error:', err);
      Toast.show({
        type: 'error',
        text1: t('wallet.fetch_error', { defaultValue: 'Error al cargar saldo' }),
        text2: err instanceof Error ? err.message : String(err),
        visibilityTime: 4500,
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, page, t]);

  useEffect(() => {
    fetchData(true);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData(true);
  };

  const handleLoadMore = () => {
    if (hasMore && !loading) fetchData(false);
  };

  // RECARGA V2 PARITY: open PDF via a fresh 1h signed URL. Linking.openURL
  // hands off to the OS browser / PDF viewer for review/share.
  const openReceiptNative = useCallback(async (storagePath: string, receiptNo: string) => {
    setOpeningReceipt(receiptNo);
    try {
      const url = await walletService.getReceiptSignedUrl(storagePath);
      await Linking.openURL(url);
    } catch (err) {
      console.error('Receipt open failed:', err);
      Toast.show({
        type: 'error',
        text1: t('wallet.receipt_open_failed', { defaultValue: 'No pudimos abrir el comprobante' }),
      });
    } finally {
      setOpeningReceipt(null);
    }
  }, [t]);

  const handleExportCSV = useCallback(async () => {
    if (!summary?.account_id) {
      Alert.alert(
        t('common.error', { defaultValue: 'Error' }),
        t('wallet.export_no_account', { defaultValue: 'No hay cuenta para exportar' }),
      );
      return;
    }
    try {
      const rows = await walletService.getTransactions(summary.account_id, 0, 1000);
      if (!rows.length) {
        Alert.alert(
          t('wallet.export_empty_title', { defaultValue: 'Nada para exportar' }),
          t('wallet.export_empty', { defaultValue: 'Aun no tienes transacciones.' }),
        );
        return;
      }
      const csv = generateWalletCSV(
        rows as Array<LedgerTransaction & { ledger_entries?: { amount: number; balance_after?: number | null }[] }>,
        'es',
      );
      const cacheDir = FileSystem.cacheDirectory;
      if (!cacheDir) {
        Alert.alert('Error', 'No se puede acceder al almacenamiento');
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const fileUri = `${cacheDir}tricigo-wallet-${today}.csv`;
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(fileUri, { mimeType: 'text/csv', dialogTitle: 'Exportar wallet' });
    } catch (err) {
      console.error('Error exporting wallet CSV:', err);
      Alert.alert(
        t('common.error', { defaultValue: 'Error' }),
        t('wallet.export_failed', { defaultValue: 'No se pudo exportar el CSV' }),
      );
    }
  }, [summary?.account_id, t]);

  const getTransactionIcon = (type: string): keyof typeof Ionicons.glyphMap => {
    switch (type) {
      case 'ride_payment': return 'car';
      case 'commission': return 'trending-down';
      case 'tip': return 'heart';
      case 'transfer_in': return 'arrow-down';
      case 'transfer_out': return 'arrow-up';
      case 'recharge': return 'add-circle';
      case 'promo_credit': return 'gift';
      case 'redemption': return 'wallet';
      case 'adjustment': return 'swap-horizontal';
      default: return 'swap-horizontal';
    }
  };

  const getTransactionColor = (type: string): string => {
    if (['ride_payment', 'tip', 'transfer_in', 'recharge', 'promo_credit'].includes(type)) {
      return colors.success.DEFAULT;
    }
    return colors.error.DEFAULT;
  };

  const isCreditType = (type: string): boolean => {
    return ['ride_payment', 'tip', 'transfer_in', 'recharge', 'promo_credit'].includes(type);
  };

  const renderTransaction = ({ item }: {
    item: LedgerTransaction & {
      ledger_entries?: { amount: number }[];
      reference_type?: string | null;
      reference_id?: string | null;
    };
  }) => {
    const amount = (item as { ledger_entries?: { amount: number }[] }).ledger_entries?.[0]?.amount ?? 0;
    const txColor = getTransactionColor(item.type);
    // RECARGA V2: only `recharge` txns whose ledger row points at a
    // payment_intent (NETOPIA / historical Stripe) have a PDF receipt.
    const receipt = item.type === 'recharge'
      && item.reference_type === 'payment_intent'
      && item.reference_id
      ? receiptByPiId.get(item.reference_id)
      : null;
    const canDownload = !!receipt?.pdf_storage_path;

    return (
      <View
        className="mx-4 mb-2 rounded-xl"
        style={{ backgroundColor: lt.card, borderWidth: 1, borderColor: lt.border.default, ...CARD_SHADOW }}
        accessible
        accessibilityLabel={`${item.type}: ${formatCUP(Math.abs(amount))}`}
      >
        <View className="flex-row items-center py-3.5 px-4">
          <View
            className="w-10 h-10 rounded-xl items-center justify-center mr-3"
            style={{ backgroundColor: `${txColor}15` }}
          >
            <Ionicons
              name={getTransactionIcon(item.type)}
              size={18}
              color={txColor}
            />
          </View>
          <View className="flex-1">
            <Text variant="body" style={{ color: lt.text.primary }} className="font-medium">
              {t(`wallet.tx_${item.type}`, { defaultValue: item.type.replace(/_/g, ' ') })}
            </Text>
            <Text variant="caption" style={{ color: lt.text.secondary }} className="mt-0.5">
              {new Date(item.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          <Text
            variant="body"
            className="font-bold tabular-nums"
            style={{ color: txColor }}
          >
            {isCreditType(item.type) ? '+' : '-'}{formatCUP(Math.abs(amount))}
          </Text>
        </View>
        {canDownload && receipt && (
          <Pressable
            onPress={() => openReceiptNative(receipt.pdf_storage_path!, receipt.receipt_no)}
            disabled={openingReceipt === receipt.receipt_no}
            style={({ pressed }) => [
              {
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingBottom: 12,
                marginTop: -4,
              },
              pressed && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('wallet.download_receipt_aria', {
              defaultValue: 'Descargar comprobante {{no}}',
              no: receipt.receipt_no,
            })}
          >
            <Ionicons name="download-outline" size={14} color={colors.brand.orange} />
            <Text
              variant="caption"
              style={{ color: colors.brand.orange, fontWeight: '600', marginLeft: 6 }}
            >
              {openingReceipt === receipt.receipt_no
                ? t('wallet.opening_receipt', { defaultValue: 'Abriendo…' })
                : `${t('wallet.download_receipt', { defaultValue: 'Comprobante' })} ${receipt.receipt_no}`}
            </Text>
          </Pressable>
        )}
      </View>
    );
  };

  if (loading) {
    return (
      <Screen bg={isDark ? 'dark' : 'lightPrimary'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded scroll>
        <View className="pt-4">
          <Text variant="h3" style={{ color: lt.text.primary }} className="mb-4">
            {t('wallet.title', { defaultValue: 'Billetera' })}
          </Text>
          <SkeletonBalance />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </Screen>
    );
  }

  const balance = summary?.available_balance ?? 0;
  const held = summary?.held_balance ?? 0;
  const totalEarned = summary?.total_earned ?? 0;
  const totalSpent = summary?.total_spent ?? 0;

  return (
    <Screen bg={isDark ? 'dark' : 'lightPrimary'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        renderItem={renderTransaction}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.brand.orange}
          />
        }
        contentContainerStyle={{ paddingBottom: 32 }}
        ListHeaderComponent={
          <View className="px-4 pt-4 mb-2">
            {/* Header con título + acción exportar */}
            <View className="flex-row items-center justify-between mb-4">
              <Text variant="h3" style={{ color: lt.text.primary }}>
                {t('wallet.title', { defaultValue: 'Billetera' })}
              </Text>
              <Pressable
                onPress={handleExportCSV}
                disabled={!summary?.account_id}
                className="w-10 h-10 rounded-xl items-center justify-center"
                style={({ pressed }) => [
                  { backgroundColor: lt.background.tertiary, opacity: !summary?.account_id ? 0.4 : 1 },
                  pressed && { transform: [{ scale: 0.95 }] },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('wallet.export_csv', { defaultValue: 'Exportar CSV' })}
              >
                <Ionicons name="download-outline" size={18} color={lt.text.secondary} />
              </Pressable>
            </View>

            {/* Balance card principal */}
            <Card variant="surface" padding="lg" className="mb-4" style={{ backgroundColor: lt.card, ...CARD_SHADOW }}>
              <Text variant="caption" style={{ color: lt.text.secondary }} className="mb-1">
                {t('wallet.balance_label', { defaultValue: 'Crédito de comisión' })}
              </Text>
              <Text variant="stat" style={{ color: lt.text.primary }}>
                {formatCUP(balance)}
              </Text>
              <Text variant="caption" style={{ color: lt.text.tertiary }} className="mt-0.5">
                {'≈'} {formatUSD(trcToUsd(balance, exchangeRate))}
              </Text>
              {held > 0 && (
                <Text variant="caption" style={{ color: lt.text.secondary }} className="mt-2">
                  {t('wallet.held', { defaultValue: 'Retenido' })}: {formatCUP(held)}
                </Text>
              )}
            </Card>

            {/* Botón Recargar (sigue ruteando a /wallet/recharge — ZONA NETOPIA, no se toca) */}
            <Pressable
              onPress={() => router.push('/wallet/recharge')}
              className="flex-row items-center justify-center py-4 rounded-2xl mb-4"
              style={({ pressed }) => [
                { backgroundColor: colors.brand.orange, minHeight: 52 },
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('wallet.recharge', { defaultValue: 'Recargar' })}
            >
              <Ionicons name="add-circle-outline" size={20} color="#FFFFFF" />
              <Text variant="body" style={{ color: '#FFFFFF', fontWeight: '700', marginLeft: 8 }}>
                {t('wallet.recharge', { defaultValue: 'Recargar' })}
              </Text>
            </Pressable>

            {/* Stats row: Total ganado / Total gastado */}
            <View className="flex-row gap-3 mb-4">
              <View className="flex-1">
                <StatCard
                  icon="trending-up"
                  value={formatCUP(totalEarned)}
                  label={t('wallet.total_earned', { defaultValue: 'Total ganado' })}
                  iconColor={colors.success.DEFAULT}
                />
              </View>
              <View className="flex-1">
                <StatCard
                  icon="trending-down"
                  value={formatCUP(totalSpent)}
                  label={t('wallet.total_spent', { defaultValue: 'Total gastado' })}
                  iconColor={colors.error.DEFAULT}
                />
              </View>
            </View>

            {/* Transactions section header */}
            <Text variant="label" style={{ color: lt.text.secondary }} className="mb-2 ml-1">
              {t('wallet.transactions', { defaultValue: 'Transacciones' })}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View className="px-4">
            <EmptyState
              icon="wallet-outline"
              title={t('wallet.no_transactions_title', { defaultValue: 'Sin transacciones' })}
              description={t('wallet.no_transactions', { defaultValue: 'Aun no tienes transacciones. Completa viajes para empezar a ganar.' })}
            />
          </View>
        }
        ListFooterComponent={
          transactions.length > 0 && hasMore ? (
            <View className="py-4 items-center">
              <ActivityIndicator size="small" color={colors.brand.orange} />
            </View>
          ) : null
        }
      />
    </Screen>
  );
}
