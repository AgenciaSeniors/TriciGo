import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Pressable, RefreshControl, ActivityIndicator, Alert, Linking } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatCard } from '@tricigo/ui/StatCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api';
import { formatCUP, generateWalletCSV } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import type { LedgerTransaction, WalletSummary } from '@tricigo/types';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

const PAGE_SIZE = 20;

export default function WalletScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const userId = useAuthStore((s) => s.user?.id);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  // RECARGA V2 PARITY: map payment_intent_id → receipt metadata so we
  // can render a "Descargar comprobante" button on each driver_quota
  // recharge txn. Mirror of `apps/client/app/(tabs)/wallet.tsx`.
  const [receiptByPiId, setReceiptByPiId] = useState<Map<string, {
    receipt_no: string;
    pdf_storage_path: string | null;
  }>>(new Map());
  const [openingReceipt, setOpeningReceipt] = useState<string | null>(null);

  const fetchData = useCallback(async (reset = false) => {
    if (!userId) return;
    try {
      const p = reset ? 0 : page;
      // Driver wallet screen summarizes the DRIVER earnings account,
      // not the rider customer_cash balance.
      const summaryData = await walletService.getSummary(userId, 'driver_cash');
      setSummary(summaryData);

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
      // with a matching payment_intent_id surfaces a download button.
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
          // Non-fatal: the txn rows just won't have a download button.
        }
      }
    } catch {
      // Silent — wallet is best-effort
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, page]);

  // RECARGA V2 PARITY: open the PDF via a fresh 1h signed URL.
  // Linking.openURL hands off to the OS browser / PDF viewer so the
  // driver can review or share the receipt outside the app.
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

  useEffect(() => {
    fetchData(true);
  }, [userId]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData(true);
  };

  const handleLoadMore = () => {
    if (hasMore && !loading) fetchData(false);
  };

  const handleExportCSV = useCallback(async () => {
    if (!summary?.account_id) {
      Alert.alert(
        t('common.error', { defaultValue: 'Error' }),
        t('wallet.export_no_account', { defaultValue: 'No hay cuenta para exportar' }),
      );
      return;
    }
    try {
      // Pull a larger slice for export (up to 1000 recent transactions)
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

  const getTransactionIcon = (type: string): string => {
    switch (type) {
      case 'ride_payment': return 'car';
      case 'commission': return 'trending-down';
      case 'tip': return 'heart';
      case 'transfer_in': return 'arrow-down';
      case 'transfer_out': return 'arrow-up';
      case 'recharge': return 'add-circle';
      case 'promo_credit': return 'gift';
      case 'redemption': return 'wallet';
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
    const amount = (item as any).ledger_entries?.[0]?.amount ?? 0;
    const txColor = getTransactionColor(item.type);
    // RECARGA V2 PARITY: only `recharge` txns whose ledger row points
    // at a payment_intent (NETOPIA / historical Stripe) have a PDF.
    const receipt = item.type === 'recharge'
      && item.reference_type === 'payment_intent'
      && item.reference_id
      ? receiptByPiId.get(item.reference_id)
      : null;
    const canDownload = !!receipt?.pdf_storage_path;
    return (
      <View
        style={{ borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' }}
        accessible
        accessibilityLabel={`${item.type}: ${formatCUP(Math.abs(amount))}`}
      >
        <Pressable
          className="flex-row items-center py-3.5 px-4"
          style={({ pressed }) => [pressed && { backgroundColor: 'rgba(255,255,255,0.03)' }]}
        >
          <View
            className="w-10 h-10 rounded-xl items-center justify-center mr-3"
            style={{ backgroundColor: `${txColor}12` }}
          >
            <Ionicons
              name={getTransactionIcon(item.type) as any}
              size={18}
              color={txColor}
            />
          </View>
          <View className="flex-1">
            <Text variant="body" color="inverse" className="font-medium">
              {t(`wallet.tx_${item.type}`, { defaultValue: item.type.replace(/_/g, ' ') })}
            </Text>
            <Text variant="caption" color="secondary" className="mt-0.5">
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
        </Pressable>
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
      <Screen bg="dark" statusBarStyle="light-content">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content">
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
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
        ListHeaderComponent={
          <View className="px-4 mb-4">
            {/* Header */}
            <View className="flex-row items-center mb-6">
              <Pressable
                onPress={() => router.back()}
                className="w-11 h-11 rounded-xl items-center justify-center mr-3"
                style={{ backgroundColor: '#252540' }}
                accessibilityRole="button"
                accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
              >
                <Ionicons name="arrow-back" size={20} color="#fff" />
              </Pressable>
              <Text variant="h2" color="inverse" className="flex-1">
                {t('wallet.title', { defaultValue: 'Mi cuenta de conductor' })}
              </Text>
              <Pressable
                onPress={handleExportCSV}
                disabled={!summary?.account_id}
                className="w-11 h-11 rounded-xl items-center justify-center"
                style={({ pressed }) => [
                  { backgroundColor: '#252540', opacity: !summary?.account_id ? 0.4 : 1 },
                  pressed && { transform: [{ scale: 0.95 }] },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('wallet.export_csv', { defaultValue: 'Exportar CSV' })}
              >
                <Ionicons name="download-outline" size={20} color="#fff" />
              </Pressable>
            </View>

            {/* Balance card */}
            <Card forceDark variant="surface" padding="lg" className="mb-4">
              <Text variant="caption" color="secondary" className="mb-1">
                {t('wallet.commission_credit', { defaultValue: 'Crédito de comisión' })}
              </Text>
              <Text variant="stat" color="inverse">
                {formatCUP(summary?.available_balance ?? 0)}
              </Text>
              {(summary?.held_balance ?? 0) > 0 && (
                <Text variant="caption" color="secondary" className="mt-1">
                  {t('wallet.held', { defaultValue: 'Retenido' })}: {formatCUP(summary?.held_balance ?? 0)}
                </Text>
              )}
              <Text variant="caption" color="tertiary" className="mt-2">
                {t('wallet.commission_credit_hint', {
                  defaultValue: 'Este saldo se usa solo para pagar comisiones de plataforma. No es retirable ni reembolsable.',
                })}
              </Text>
            </Card>

            {/* Action buttons */}
            <View className="flex-row gap-3 mb-4">
              <Pressable
                onPress={() => router.push('/wallet/recharge')}
                className="flex-1 items-center justify-center py-4 rounded-2xl"
                style={({ pressed }) => [
                  { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', minHeight: 56 },
                  pressed && { backgroundColor: '#252540', transform: [{ scale: 0.97 }] },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('wallet.recharge', { defaultValue: 'Recargar' })}
              >
                <View className="w-10 h-10 rounded-full items-center justify-center mb-1" style={{ backgroundColor: 'rgba(255,77,0,0.1)' }}>
                  <Ionicons name="add-circle-outline" size={20} color={colors.brand.orange} />
                </View>
                <Text variant="bodySmall" color="inverse" className="font-semibold">
                  {t('wallet.recharge', { defaultValue: 'Recargar' })}
                </Text>
              </Pressable>
            </View>

            {/* Stats row */}
            <View className="flex-row gap-3 mb-4">
              <View className="flex-1">
                <StatCard
                  forceDark
                  icon="trending-up"
                  value={formatCUP(summary?.total_earned ?? 0)}
                  label={t('wallet.total_earned', { defaultValue: 'Total ganado' })}
                  iconColor={colors.success.DEFAULT}
                />
              </View>
              <View className="flex-1">
                <StatCard
                  forceDark
                  icon="trending-down"
                  value={formatCUP(summary?.total_spent ?? 0)}
                  label={t('wallet.total_spent', { defaultValue: 'Total gastado' })}
                  iconColor={colors.error.DEFAULT}
                />
              </View>
            </View>

            {/* Transactions header */}
            <Text variant="h4" color="inverse" className="mb-2">
              {t('wallet.transactions', { defaultValue: 'Transacciones' })}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            forceDark
            icon="wallet-outline"
            title={t('wallet.no_transactions_title', { defaultValue: 'Sin transacciones' })}
            description={t('wallet.no_transactions', { defaultValue: 'Aun no tienes transacciones. Completa viajes para empezar a ganar.' })}
          />
        }
      />
    </Screen>
  );
}
