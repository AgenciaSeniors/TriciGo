// ============================================================
// Mis Viajes — Cuban Modern redesign (post-PR #232).
//
// Trip cards refactoreados a paleta cubanLight/cubanDark con warm-gold
// accents, status pills colored-alpha, Inter_800ExtraBold tabular-nums
// para "Ganaste". Screen wrapper cream/navy. HistoryFilters (shared
// component) queda intacto (decisión user: out of scope).
//
// Lógica intacta: fetchTrips, paginación, filtros, CSV export, refresh,
// commission rate fallback.
// ============================================================

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
  Animated,
  Easing,
  StyleSheet,
  useColorScheme,
} from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api/services/driver';
import {
  formatTRC,
  formatUSD,
  formatCUP,
  DEFAULT_EXCHANGE_RATE,
  generateHistoryCSV,
  getRelativeDay,
  riderChargedTotal,
} from '@tricigo/utils';
import { walletService } from '@tricigo/api';
import { tripNetEarnings } from '@/utils/tripNetEarnings';
import type { Ride } from '@tricigo/types';
import { cubanLight, cubanDark, colors } from '@tricigo/theme';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { useDriverStore } from '@/stores/driver.store';
import { HistoryFilters } from '@tricigo/ui/HistoryFilters';
import type { HistoryFilterState } from '@tricigo/ui/HistoryFilters';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';

const PAGE_SIZE = 20;

// Tabular-nums style for number alignment
const TABULAR: { fontVariant: ('tabular-nums')[] } = { fontVariant: ['tabular-nums'] };

function NativeTripsScreen() {
  const { t } = useTranslation('driver');
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  // Cuban palette
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };

  const [trips, setTrips] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // BUG-trips-counter-parity: default solo completed (no canceled mezclados).
  const [filters, setFilters] = useState<HistoryFilterState>({ status: ['completed'] });
  const [commissionRate, setCommissionRate] = useState(0.15);

  useEffect(() => {
    walletService.getConfigValue('commission_rate')
      .then((val) => {
        if (val) {
          const parsed = parseFloat(String(val).replace(/"/g, ''));
          if (!isNaN(parsed) && parsed > 0 && parsed < 1) setCommissionRate(parsed);
        }
      })
      .catch(() => { /* best-effort: queda en 0.15 */ });
  }, []);

  const serviceTypes = [
    { value: 'triciclo_basico', label: t('onboarding.triciclo', { defaultValue: 'Triciclo' }) },
    { value: 'moto_standard', label: t('onboarding.moto', { defaultValue: 'Moto' }) },
    { value: 'auto_standard', label: t('onboarding.auto', { defaultValue: 'Auto' }) },
  ];

  const paymentMethods = [
    { value: 'cash', label: t('common.cash', { defaultValue: 'Efectivo' }) },
    { value: 'tricicoin', label: t('trip.tricicoin', { defaultValue: 'TriciCoin' }) },
  ];

  const filterLabels = useMemo(() => ({
    filters: t('trips_history.filters', { defaultValue: 'Filtros' }),
    all: t('trips_history.all_statuses', { defaultValue: 'Todos' }),
    completed: t('trips_history.completed', { defaultValue: 'Completado' }),
    canceled: t('trips_history.canceled', { defaultValue: 'Cancelado' }),
    serviceType: t('trips_history.service_type', { defaultValue: 'Tipo de servicio' }),
    paymentMethod: t('trips_history.payment_method', { defaultValue: 'Método de pago' }),
    clearFilters: t('trips_history.clear_filters', { defaultValue: 'Limpiar filtros' }),
  }), [t]);

  useEffect(() => {
    if (!driverProfileId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    async function fetchTrips() {
      try {
        const data = await driverService.getTripHistoryFiltered({
          driverId: driverProfileId!,
          page,
          pageSize: PAGE_SIZE,
          status: filters.status,
          serviceType: filters.serviceType as any,
          paymentMethod: filters.paymentMethod as any,
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
        });
        if (!cancelled) {
          setTrips((prev) => {
            if (page === 0) return data;
            const seen = new Set(prev.map((trip) => trip.id));
            return [...prev, ...data.filter((trip) => !seen.has(trip.id))];
          });
        }
      } catch (err) {
        console.error('Error fetching trips:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTrips();
    return () => { cancelled = true; };
  }, [driverProfileId, page, filters]);

  const handleFilterChange = useCallback((newFilters: HistoryFilterState) => {
    setFilters(newFilters);
    setPage(0);
  }, []);

  const handleExportCSV = useCallback(async () => {
    if (trips.length === 0) return;
    try {
      const csv = generateHistoryCSV(trips, 'es');
      const cacheDir = FileSystem.cacheDirectory;
      if (!cacheDir) { Alert.alert('Error', 'No se puede acceder al almacenamiento'); return; }
      const fileUri = cacheDir + 'historial_viajes.csv';
      await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(fileUri, { mimeType: 'text/csv', dialogTitle: 'Exportar historial' });
    } catch (err) {
      console.error('Error exporting CSV:', err);
      Alert.alert(
        t('common:errors.title', { defaultValue: 'Error' }),
        t('trips.export_failed', { defaultValue: 'No se pudo exportar el CSV' }),
      );
    }
  }, [trips, t]);

  const loadMore = useCallback(() => {
    if (trips.length >= (page + 1) * PAGE_SIZE) {
      setPage((p) => p + 1);
    }
  }, [trips.length, page]);

  const onRefresh = useCallback(async () => {
    if (!driverProfileId) return;
    setRefreshing(true);
    try {
      const data = await driverService.getTripHistoryFiltered({
        driverId: driverProfileId,
        page: 0,
        pageSize: PAGE_SIZE,
        status: filters.status,
        serviceType: filters.serviceType as any,
        paymentMethod: filters.paymentMethod as any,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
      setTrips(data);
      setPage(0);
    } catch (err) {
      console.error('Error refreshing trips:', err);
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRefreshing(false);
    }
  }, [driverProfileId, filters]);

  // ── Trip card render (Cuban Modern) ────────────────────────────────
  const renderItem = useCallback(({ item }: { item: Ride & { commission_amount?: number | null } }) => {
    const isCompleted = item.status === 'completed';
    const netEarningsCup = isCompleted ? tripNetEarnings(item, commissionRate) : 0;
    const chargedCup = isCompleted ? riderChargedTotal(item) : (item.estimated_fare_cup ?? 0);
    const rate = item.exchange_rate_usd_cup ?? DEFAULT_EXCHANGE_RATE;
    const primaryUsd = ((isCompleted ? netEarningsCup : chargedCup)) / rate;
    const deduction = item.quota_deduction_amount ?? 0;
    const statusColor = isCompleted ? '#22C55E' : '#EF4444';
    const statusDarker = isCompleted ? '#16A34A' : '#DC2626';

    return (
      <Pressable
        onPress={() => router.push(`/trip/${item.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`${
          isCompleted
            ? t('trips_history.completed', { defaultValue: 'Completado' })
            : t('trips_history.canceled', { defaultValue: 'Cancelado' })
        }, ${item.pickup_address} → ${item.dropoff_address}, ${
          isCompleted
            ? t('trips_history.you_earned', { defaultValue: 'Ganaste' }) + ' ' + formatCUP(netEarningsCup)
            : formatCUP(chargedCup)
        }`}
        style={({ pressed }) => [
          {
            marginHorizontal: 16,
            marginBottom: 12,
            backgroundColor: palette.bg.elev1,
            borderRadius: 16,
            ...CARD_SHADOW,
          },
          pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] },
        ]}
      >
        {/* Date + status pill */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 14,
            paddingTop: 14,
            paddingBottom: 10,
          }}
        >
          <Text style={{ color: palette.ink.secondary, fontSize: 12, fontWeight: '600', flex: 1 }}>
            {getRelativeDay(item.created_at, t('common.today'), t('common.yesterday'))}
          </Text>
          <View
            style={{
              backgroundColor: `${statusColor}22`,
              borderRadius: 9999,
              paddingHorizontal: 10,
              paddingVertical: 3,
            }}
          >
            <Text
              style={{
                color: statusDarker,
                fontSize: 10,
                fontWeight: '800',
                textTransform: 'uppercase',
                letterSpacing: 0.6,
              }}
            >
              {isCompleted
                ? t('trips_history.completed', { defaultValue: 'Completado' })
                : t('trips_history.canceled', { defaultValue: 'Cancelado' })}
            </Text>
          </View>
        </View>

        {/* Pickup → dropoff */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingBottom: 12 }}>
          {/* Markers column */}
          <View style={{ width: 12, alignItems: 'center', paddingTop: 5 }}>
            <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#22C55E' }} />
            <View
              style={{ width: 2, flex: 1, backgroundColor: palette.line, marginVertical: 3, minHeight: 16 }}
            />
            <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: colors.brand.orange }} />
          </View>
          {/* Addresses */}
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: palette.ink.primary, fontSize: 14, fontWeight: '500' }} numberOfLines={1}>
              {item.pickup_address}
            </Text>
            <View style={{ height: 14 }} />
            <Text style={{ color: palette.ink.primary, fontSize: 14, fontWeight: '500' }} numberOfLines={1}>
              {item.dropoff_address}
            </Text>
          </View>
        </View>

        {/* Earnings row */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 14,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: palette.line,
          }}
        >
          <View style={{ flex: 1 }}>
            {isCompleted ? (
              <>
                <Text
                  style={{
                    color: palette.ink.secondary,
                    fontSize: 10,
                    fontWeight: '700',
                    textTransform: 'uppercase',
                    letterSpacing: 0.8,
                    marginBottom: 2,
                  }}
                >
                  {t('trips_history.you_earned', { defaultValue: 'Ganaste' })}
                </Text>
                <Text
                  style={{
                    color: palette.ink.primary,
                    fontFamily: 'Inter_800ExtraBold',
                    fontSize: 20,
                    letterSpacing: -0.5,
                    ...TABULAR,
                  }}
                >
                  {formatCUP(netEarningsCup)}
                </Text>
                <Text
                  style={{
                    color: palette.ink.subtle,
                    fontSize: 11,
                    marginTop: 3,
                    ...TABULAR,
                  }}
                >
                  {t('trips_history.charged_to_client', { defaultValue: 'Cobrado al cliente' })}: {formatCUP(chargedCup)}
                </Text>
                {(item.tip_amount ?? 0) > 0 && (
                  <Text style={{ color: '#22C55E', fontSize: 11, fontWeight: '600', marginTop: 2, ...TABULAR }}>
                    {t('trips_history.tip_included', { defaultValue: 'Incluye propina' })} +{formatCUP(item.tip_amount ?? 0)}
                  </Text>
                )}
              </>
            ) : (
              <>
                <Text
                  style={{
                    color: palette.ink.primary,
                    fontFamily: 'Inter_700Bold',
                    fontSize: 18,
                    ...TABULAR,
                  }}
                >
                  {formatCUP(chargedCup)}
                </Text>
                <Text style={{ color: palette.ink.subtle, fontSize: 11, marginTop: 3, ...TABULAR }}>
                  ≈ {formatUSD(primaryUsd)}
                </Text>
              </>
            )}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            {deduction > 0 && (
              <Text style={{ color: '#EF4444', fontSize: 11, fontWeight: '700', marginBottom: 4, ...TABULAR }}>
                −{formatTRC(deduction)}
              </Text>
            )}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: palette.bg.elev2,
                borderRadius: 9999,
                paddingHorizontal: 8,
                paddingVertical: 3,
              }}
            >
              <Ionicons
                name={item.payment_method === 'cash' ? 'cash-outline' : 'wallet-outline'}
                size={11}
                color={palette.ink.secondary}
                style={{ marginRight: 4 }}
              />
              <Text style={{ color: palette.ink.secondary, fontSize: 11, fontWeight: '600' }}>
                {item.payment_method === 'cash' ? t('common.cash') : t('trip.tricicoin')}
              </Text>
            </View>
          </View>
        </View>
      </Pressable>
    );
  }, [t, commissionRate, palette, CARD_SHADOW]);

  // ── Stagger entrance — header (0) + filters (1) + list area (2) ────
  const fadeAnim = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  useEffect(() => {
    if (!loading || page === 0) {
      // re-trigger on filter change
      fadeAnim.forEach((a) => a.setValue(0));
      Animated.stagger(
        80,
        fadeAnim.map((a) =>
          Animated.timing(a, {
            toValue: 1,
            duration: 360,
            useNativeDriver: true,
            easing: Easing.out(Easing.cubic),
          }),
        ),
      ).start();
    }
  }, [loading, page, fadeAnim]);

  const sectionStyle = (idx: number) => ({
    opacity: fadeAnim[idx]!,
    transform: [
      {
        translateY: fadeAnim[idx]!.interpolate({
          inputRange: [0, 1],
          outputRange: [10, 0],
        }),
      },
    ],
  });

  return (
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper, paddingTop: 16 }}>
        {/* Header — title + CSV export */}
        <Animated.View
          style={[
            sectionStyle(0),
            {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 16,
              marginBottom: 12,
            },
          ]}
        >
          <Text
            style={{
              color: palette.ink.primary,
              fontSize: 28,
              fontWeight: '800',
              letterSpacing: -0.5,
            }}
          >
            {t('trips_history.title', { defaultValue: 'Mis viajes' })}
          </Text>
          {trips.length > 0 && (
            <Pressable
              onPress={handleExportCSV}
              style={({ pressed }) => [
                {
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  backgroundColor: palette.bg.elev2,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                pressed && { transform: [{ scale: 0.94 }] },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('trips_history.export_csv', { defaultValue: 'Exportar CSV' })}
            >
              <Ionicons name="download-outline" size={18} color={palette.ink.secondary} />
            </Pressable>
          )}
        </Animated.View>

        {/* HistoryFilters (shared) — intacto */}
        <Animated.View style={[sectionStyle(1), { paddingHorizontal: 16 }]}>
          <HistoryFilters
            filters={filters}
            onFilterChange={handleFilterChange}
            serviceTypes={serviceTypes}
            paymentMethods={paymentMethods}
            labels={filterLabels}
          />
        </Animated.View>

        {/* List area */}
        <Animated.View style={[sectionStyle(2), { flex: 1, marginTop: 8 }]}>
          {error && !loading ? (
            <View style={{ paddingHorizontal: 16 }}>
              <ErrorState
                title={t('trips_history.error_title', { defaultValue: 'Error al cargar viajes' })}
                description={error}
                onRetry={() => {
                  setError(null);
                  setPage(0);
                }}
                retryLabel={t('common.retry', { defaultValue: 'Reintentar' })}
              />
            </View>
          ) : loading && page === 0 ? (
            <View style={{ paddingHorizontal: 16 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <View
                  key={i}
                  style={{
                    height: 130,
                    borderRadius: 16,
                    backgroundColor: palette.bg.elev1,
                    marginBottom: 12,
                    opacity: 1 - i * 0.12,
                  }}
                >
                  <SkeletonListItem />
                </View>
              ))}
            </View>
          ) : (
            <FlatList
              data={trips}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  colors={[colors.brand.orange]}
                  tintColor={colors.brand.orange}
                />
              }
              contentContainerStyle={{ paddingBottom: 24 }}
              ListEmptyComponent={
                Object.values(filters).some((v) => v !== undefined && v !== null && v !== '') ? (
                  <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
                    <EmptyState
                      icon="filter-outline"
                      title={t('trips_history.no_results_title', { defaultValue: 'Sin resultados' })}
                      description={t('trips_history.no_results_description', {
                        defaultValue: 'No hay viajes que coincidan con los filtros seleccionados.',
                      })}
                      action={{
                        label: t('trips_history.clear_filters', { defaultValue: 'Limpiar filtros' }),
                        onPress: () => {
                          setFilters({});
                          setPage(0);
                        },
                      }}
                    />
                  </View>
                ) : (
                  <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
                    <EmptyState
                      icon="car-outline"
                      title={t('trips_history.no_trips_title', { defaultValue: 'Aún no has hecho viajes' })}
                      description={t('trips_history.no_trips_description', {
                        defaultValue: 'Cuando completes tu primer viaje aparecerá aquí con todos los detalles.',
                      })}
                      action={{
                        label: t('trips_history.go_online_cta', { defaultValue: 'Ir a Inicio' }),
                        onPress: () => router.push('/(tabs)'),
                      }}
                    />
                  </View>
                )
              }
              ListFooterComponent={
                trips.length >= (page + 1) * PAGE_SIZE ? (
                  <View style={{ paddingHorizontal: 16, marginTop: 8, marginBottom: 24 }}>
                    <Button
                      title={t('trips_history.load_more')}
                      variant="outline"
                      size="sm"
                      onPress={loadMore}
                      loading={loading && page > 0}
                    />
                  </View>
                ) : null
              }
            />
          )}
        </Animated.View>
      </View>
    </Screen>
  );
}

export default function TripsScreen() {
  return <NativeTripsScreen />;
}
