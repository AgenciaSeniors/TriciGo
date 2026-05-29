// ============================================================
// Wallet driver — Cuban Modern premium redesign (post-PR #231)
//
// Visual layer: paleta cubanLight/cubanDark (warm cream + navy + gold),
// LinearGradient hero balance card con orange glow radial, CTA "Recargar
// wallet" con halo naranja + spring animation, StatCards Cuban-styled,
// stagger fade-in entrance, transactions con pill "Comprobante" gold.
//
// Lógica intacta: fetchData (post-00324 RPC fix), Toast on error,
// pagination, refresh, CSV export, receipt download, useColorScheme.
// Route /wallet/recharge (zona NETOPIA) intacta.
//
// Fuentes: Inter (cargado en _layout) + tabular-nums fontVariant para
// alineación numérica. BricolageGrotesque/JetBrainsMono no están
// cargadas en driver app — usamos Inter_800ExtraBold para hero monto.
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  FlatList,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Linking,
  Animated,
  Easing,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { formatCUP, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE, generateWalletCSV } from '@tricigo/utils';
import { colors, cubanLight, cubanDark } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import type { LedgerTransaction, WalletSummary } from '@tricigo/types';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

const PAGE_SIZE = 20;

// Tabular-nums style for number alignment (CUP, USD totals)
const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };

export default function WalletScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);

  // Cuban Modern palette — warm cream light / navy profundo dark
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  // RN-style shadows (cuban*.shadow.hero is CSS string syntax — not portable)
  const HERO_SHADOW = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: isDark ? 0.28 : 0.16,
    shadowRadius: 24,
    elevation: 12,
  };
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };
  const GLOW_CTA = {
    shadowColor: '#FF4D00',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  };

  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  // RECARGA V2 PARITY: map payment_intent_id → receipt metadata so we
  // can render a "Comprobante" pill on each tricicoin recharge txn.
  const [receiptByPiId, setReceiptByPiId] = useState<Map<string, {
    receipt_no: string;
    pdf_storage_path: string | null;
  }>>(new Map());
  const [openingReceipt, setOpeningReceipt] = useState<string | null>(null);

  const fetchData = useCallback(async (reset = false) => {
    if (!userId) return;
    try {
      const p = reset ? 0 : page;
      // 00300: single-wallet driver model → tricicoin es la única fuente.
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

      // Best-effort receipt map (NETOPIA recharges → PDF link)
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
          // Non-fatal
        }
      }
    } catch (err) {
      // 00324: surface RPC errors via Toast (no more silent zeroes)
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

  // Refetch whenever the Wallet tab regains focus. The common flow is
  // "user opens /wallet/recharge, completes payment, taps back" — the
  // wallet screen stays mounted in that case and the [userId] effect
  // above does NOT re-run. Without this hook, the new recharge txn
  // never appears in the Movimientos list until the user pull-to-
  // refreshes manually. Bug observed 2026-05-27 (intent bf2840ba).
  useFocusEffect(
    useCallback(() => {
      fetchData(true);
    }, [fetchData])
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData(true);
  };

  const handleLoadMore = () => {
    if (hasMore && !loading) fetchData(false);
  };

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
    const receipt = item.type === 'recharge'
      && item.reference_type === 'payment_intent'
      && item.reference_id
      ? receiptByPiId.get(item.reference_id)
      : null;
    const canDownload = !!receipt?.pdf_storage_path;

    return (
      <View
        style={{
          marginHorizontal: 16,
          marginBottom: 8,
          backgroundColor: palette.bg.elev1,
          borderRadius: 14,
          ...CARD_SHADOW,
        }}
        accessible
        accessibilityLabel={`${item.type}: ${formatCUP(Math.abs(amount))}`}
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
            <Ionicons name={getTransactionIcon(item.type)} size={18} color={txColor} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: palette.ink.primary, fontWeight: '600', fontSize: 14 }}>
              {t(`wallet.tx_${item.type}`, { defaultValue: item.type.replace(/_/g, ' ') })}
            </Text>
            <Text style={{ color: palette.ink.secondary, fontSize: 12, marginTop: 2 }}>
              {new Date(item.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          <Text style={{ color: txColor, fontWeight: '700', fontSize: 15, ...TABULAR }}>
            {isCreditType(item.type) ? '+' : '−'}{formatCUP(Math.abs(amount))}
          </Text>
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
            accessibilityLabel={t('wallet.download_receipt_aria', {
              defaultValue: 'Descargar comprobante {{no}}',
              no: receipt.receipt_no,
            })}
          >
            <View
              style={{
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: palette.accent.warm,
                borderRadius: 9999,
                paddingHorizontal: 10,
                paddingVertical: 4,
                marginLeft: 52, // aligns with text start (icon 40 + margin 12)
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
    );
  };

  // ── Stagger entrance animations ────────────────────────────────────
  // 4 sections: balance hero (0), recharge CTA (1), stats row (2), txns header (3).
  // Each fades in + slides up 12px. Kicks off when `loading` flips false.
  const fadeAnim = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  useEffect(() => {
    if (!loading) {
      Animated.stagger(
        80,
        fadeAnim.map((a) =>
          Animated.timing(a, {
            toValue: 1,
            duration: 380,
            useNativeDriver: true,
            easing: Easing.out(Easing.cubic),
          }),
        ),
      ).start();
    }
  }, [loading, fadeAnim]);

  const sectionTranslateY = (idx: number) =>
    fadeAnim[idx]!.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  const sectionStyle = (idx: number) => ({
    opacity: fadeAnim[idx]!,
    transform: [{ translateY: sectionTranslateY(idx) }],
  });

  // ── CTA press feedback (spring scale) ──────────────────────────────
  const ctaScale = useRef(new Animated.Value(1)).current;
  const handleCtaPressIn = () =>
    Animated.spring(ctaScale, { toValue: 0.97, useNativeDriver: true, speed: 50, bounciness: 4 }).start();
  const handleCtaPressOut = () =>
    Animated.spring(ctaScale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }).start();

  if (loading) {
    return (
      <Screen
        bg={isDark ? 'dark' : 'white'}
        statusBarStyle={isDark ? 'light-content' : 'dark-content'}
      >
        <View style={{ flex: 1, backgroundColor: palette.bg.paper, paddingHorizontal: 16, paddingTop: 16 }}>
          <Text style={{ color: palette.ink.primary, fontSize: 28, fontWeight: '800', marginBottom: 20 }}>
            {t('wallet.title', { defaultValue: 'Billetera' })}
          </Text>
          {/* Hero skeleton */}
          <View style={{ height: 160, borderRadius: 24, backgroundColor: palette.bg.elev1, marginBottom: 20, ...CARD_SHADOW }} />
          {/* CTA skeleton */}
          <View style={{ height: 60, borderRadius: 20, backgroundColor: palette.bg.elev1, marginBottom: 20, opacity: 0.6 }} />
          {/* Stats skeleton */}
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1, height: 100, borderRadius: 16, backgroundColor: palette.bg.elev1 }} />
            <View style={{ flex: 1, height: 100, borderRadius: 16, backgroundColor: palette.bg.elev1 }} />
          </View>
        </View>
      </Screen>
    );
  }

  const balance = summary?.available_balance ?? 0;
  const held = summary?.held_balance ?? 0;
  const totalEarned = summary?.total_earned ?? 0;
  const totalSpent = summary?.total_spent ?? 0;

  return (
    <Screen
      bg={isDark ? 'dark' : 'white'}
      statusBarStyle={isDark ? 'light-content' : 'dark-content'}
    >
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
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
            <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
              {/* Header — title + export CSV */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                <Text style={{ color: palette.ink.primary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 }}>
                  {t('wallet.title', { defaultValue: 'Billetera' })}
                </Text>
                <Pressable
                  onPress={handleExportCSV}
                  disabled={!summary?.account_id}
                  style={({ pressed }) => [
                    {
                      width: 40,
                      height: 40,
                      borderRadius: 12,
                      backgroundColor: palette.bg.elev2,
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: !summary?.account_id ? 0.4 : 1,
                    },
                    pressed && { transform: [{ scale: 0.94 }] },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t('wallet.export_csv', { defaultValue: 'Exportar CSV' })}
                >
                  <Ionicons name="download-outline" size={18} color={palette.ink.secondary} />
                </Pressable>
              </View>

              {/* ── Hero Balance Card ──────────────────────────────── */}
              <Animated.View style={[sectionStyle(0), { borderRadius: 24, overflow: 'hidden', marginBottom: 18, ...HERO_SHADOW }]}>
                {/* Layer 1: base gradient */}
                <LinearGradient
                  colors={isDark ? ['#11172A', '#18203A'] : ['#FFFFFF', '#FFFBF5']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFillObject}
                />
                {/* Layer 2: orange glow accent (top-right corner) */}
                <LinearGradient
                  colors={[palette.accent.orangeGlow, 'transparent']}
                  start={{ x: 1, y: 0 }}
                  end={{ x: 0.3, y: 0.7 }}
                  style={{ position: 'absolute', top: 0, right: 0, width: 180, height: 180 }}
                  pointerEvents="none"
                />
                {/* Layer 3: content */}
                <View style={{ padding: 24 }}>
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: '700',
                      letterSpacing: 1.6,
                      color: palette.ink.secondary,
                      textTransform: 'uppercase',
                      marginBottom: 10,
                    }}
                  >
                    {t('wallet.balance_label', { defaultValue: 'Crédito de comisión' })}
                  </Text>
                  <Text
                    style={{
                      fontFamily: 'Inter_800ExtraBold',
                      fontSize: 42,
                      letterSpacing: -1.2,
                      lineHeight: 48,
                      color: palette.ink.primary,
                      ...TABULAR,
                    }}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {formatCUP(balance)}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: palette.accent.warm,
                        marginRight: 8,
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 15,
                        fontWeight: '600',
                        color: palette.accent.warm,
                        ...TABULAR,
                      }}
                    >
                      ≈ {formatUSD(trcToUsd(balance, exchangeRate))}
                    </Text>
                  </View>
                  {held > 0 && (
                    <View
                      style={{
                        marginTop: 16,
                        alignSelf: 'flex-start',
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: palette.accent.orangeGlow,
                        borderRadius: 9999,
                        paddingHorizontal: 12,
                        paddingVertical: 5,
                      }}
                    >
                      <Ionicons name="lock-closed" size={11} color={palette.accent.orange} style={{ marginRight: 5 }} />
                      <Text style={{ color: palette.accent.orange, fontSize: 12, fontWeight: '700', ...TABULAR }}>
                        {t('wallet.held', { defaultValue: 'Retenido' })}: {formatCUP(held)}
                      </Text>
                    </View>
                  )}
                </View>
              </Animated.View>

              {/* ── CTA Recargar wallet ──────────────────────────────
                  Combine stagger fade-in (opacity + translateY) with
                  press scale into ONE Animated.View transform array. */}
              <Animated.View
                style={{
                  opacity: fadeAnim[1]!,
                  marginBottom: 22,
                  ...GLOW_CTA,
                  transform: [
                    { translateY: sectionTranslateY(1) },
                    { scale: ctaScale },
                  ],
                }}
              >
                <Pressable
                  onPress={() => router.push('/wallet/recharge')}
                  onPressIn={handleCtaPressIn}
                  onPressOut={handleCtaPressOut}
                  style={{ borderRadius: 20, overflow: 'hidden' }}
                  accessibilityRole="button"
                  accessibilityLabel={t('wallet.recharge', { defaultValue: 'Recargar wallet' })}
                >
                  <LinearGradient
                    colors={[colors.brand.orange, palette.accent.warm]}
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
                    <Text
                      style={{
                        color: '#FFFFFF',
                        fontFamily: 'Inter_700Bold',
                        fontSize: 17,
                        marginLeft: 10,
                        letterSpacing: 0.3,
                      }}
                    >
                      {t('wallet.recharge', { defaultValue: 'Recargar wallet' })}
                    </Text>
                    <Ionicons name="chevron-forward" size={18} color="#FFFFFF" style={{ marginLeft: 8, opacity: 0.85 }} />
                  </LinearGradient>
                </Pressable>
              </Animated.View>

              {/* ── Regalar (gift) — secondary action ────────────────
                  Closed-loop: a driver can gift TriciCoin from their
                  tricicoin balance to another active TriciGo user. */}
              <Animated.View style={[sectionStyle(1), { marginBottom: 24, marginTop: -6 }]}>
                <Pressable
                  onPress={() => router.push('/wallet/gift')}
                  style={({ pressed }) => [
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingVertical: 14,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: palette.line,
                      backgroundColor: palette.bg.elev1,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={t('wallet.gift', { defaultValue: 'Regalar' })}
                >
                  <Ionicons name="gift-outline" size={20} color={palette.accent.orange} />
                  <Text style={{ color: palette.ink.primary, fontFamily: 'Inter_700Bold', fontSize: 15, marginLeft: 10 }}>
                    {t('wallet.gift', { defaultValue: 'Regalar' })}
                  </Text>
                </Pressable>
              </Animated.View>

              {/* ── Stats row ──────────────────────────────────────── */}
              <Animated.View style={[sectionStyle(2), { flexDirection: 'row', gap: 12, marginBottom: 24 }]}>
                {[
                  { label: t('wallet.total_earned', { defaultValue: 'Total ganado' }), value: totalEarned, icon: 'trending-up' as const, tint: '#22C55E' },
                  { label: t('wallet.total_spent', { defaultValue: 'Total gastado' }), value: totalSpent, icon: 'trending-down' as const, tint: '#EF4444' },
                ].map((stat) => (
                  <View
                    key={stat.label}
                    style={{
                      flex: 1,
                      backgroundColor: palette.bg.elev1,
                      borderRadius: 16,
                      padding: 16,
                      ...CARD_SHADOW,
                    }}
                  >
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 12,
                        backgroundColor: `${stat.tint}22`,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginBottom: 12,
                      }}
                    >
                      <Ionicons name={stat.icon} size={18} color={stat.tint} />
                    </View>
                    <Text
                      style={{
                        color: palette.ink.primary,
                        fontFamily: 'Inter_700Bold',
                        fontSize: 17,
                        letterSpacing: -0.3,
                        ...TABULAR,
                      }}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                    >
                      {formatCUP(stat.value)}
                    </Text>
                    <Text style={{ color: palette.ink.secondary, fontSize: 12, marginTop: 4 }}>
                      {stat.label}
                    </Text>
                  </View>
                ))}
              </Animated.View>

              {/* ── Transactions section header ─────────────────────── */}
              <Animated.View style={[sectionStyle(3), { flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingLeft: 4 }]}>
                <Text style={{ color: palette.ink.primary, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 }}>
                  {t('wallet.transactions', { defaultValue: 'Transacciones' })}
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: palette.line, marginLeft: 12 }} />
              </Animated.View>
            </View>
          }
          ListEmptyComponent={
            <View style={{ paddingHorizontal: 16 }}>
              <EmptyState
                icon="wallet-outline"
                title={t('wallet.no_transactions_title', { defaultValue: 'Sin transacciones' })}
                description={t('wallet.no_transactions', { defaultValue: 'Aun no tienes transacciones. Completa viajes para empezar a ganar.' })}
              />
            </View>
          }
          ListFooterComponent={
            transactions.length > 0 && hasMore ? (
              <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={colors.brand.orange} />
              </View>
            ) : null
          }
        />
      </View>
    </Screen>
  );
}
