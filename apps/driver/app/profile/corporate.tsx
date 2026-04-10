import React, { useState, useEffect } from 'react';
import { View, Pressable, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { AnimatedCard, StaggeredList } from '@tricigo/ui/AnimatedCard';
import { getSupabaseClient } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';

type FleetInfo = {
  id: string;
  name: string;
  contact_email: string;
  status: 'active' | 'inactive';
};

type CorpRide = {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  fare: number;
  created_at: string;
  corporate_account_name: string;
};

type BillingSummary = {
  month: string;
  total_rides: number;
  total_earnings: number;
  commission_rate: number;
};

type SpecialRate = {
  service_type: string;
  rate_multiplier: number;
  description: string;
};

export default function CorporateScreen() {
  const { t } = useTranslation('driver');
  const driverProfile = useDriverStore((s) => s.profile);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fleet, setFleet] = useState<FleetInfo | null>(null);
  const [rides, setRides] = useState<CorpRide[]>([]);
  const [billing, setBilling] = useState<BillingSummary[]>([]);
  const [rates, setRates] = useState<SpecialRate[]>([]);

  const fetchData = async () => {
    if (!driverProfile?.id) return;
    try {
      const supabase = getSupabaseClient();

      // Get fleet membership
      const { data: fleetData } = await supabase
        .from('fleet_drivers')
        .select('fleet:fleets(*)')
        .eq('driver_id', driverProfile.id)
        .eq('status', 'active')
        .limit(1)
        .single();

      if (fleetData?.fleet) {
        setFleet(fleetData.fleet as unknown as FleetInfo);
      }

      // Get corporate rides
      const { data: ridesData } = await supabase
        .from('rides')
        .select('id, pickup_address, dropoff_address, fare, created_at, corporate_account:corporate_accounts(name)')
        .eq('driver_id', driverProfile.id)
        .not('corporate_account_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20);

      setRides(
        (ridesData ?? []).map((r: Record<string, unknown>) => ({
          id: r.id as string,
          pickup_address: r.pickup_address as string,
          dropoff_address: r.dropoff_address as string,
          fare: r.fare as number,
          created_at: r.created_at as string,
          corporate_account_name: ((r.corporate_account as Record<string, string>)?.name) ?? 'Corporate',
        })),
      );

      // Get special corporate rates
      const { data: ratesData } = await supabase
        .from('corporate_rates')
        .select('*')
        .eq('driver_id', driverProfile.id);

      setRates((ratesData as SpecialRate[]) ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [driverProfile?.id]);

  return (
    <Screen
      scroll
      bg="lightPrimary"
      statusBarStyle="dark-content"
      padded
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} tintColor={colors.brand.orange} />}
    >
      <View className="pt-4 pb-8">
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: colors.neutral[100] }}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[800]} />
          </Pressable>
          <Text variant="h3" color="primary">
            {t('corporate.title', { defaultValue: 'Corporativo' })}
          </Text>
        </View>

        {loading && (
          <View className="gap-3">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {!loading && !fleet && (
          <EmptyState

            icon="business-outline"
            title={t('corporate.no_fleet', { defaultValue: 'Sin flota asignada' })}
            description={t('corporate.no_fleet_desc', { defaultValue: 'No perteneces a ninguna flota corporativa. Contacta a tu administrador para unirte.' })}
          />
        )}

        {!loading && fleet && (
          <>
            {/* Fleet Card */}
            <Text variant="label" color="secondary" className="mb-2 ml-1">
              {t('corporate.fleet_section', { defaultValue: 'Tu flota' })}
            </Text>
            <AnimatedCard delay={0} className="rounded-2xl p-4 mb-6"
              style={{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0' }}
            >
              <View className="flex-row items-center">
                <View className="w-12 h-12 rounded-2xl items-center justify-center mr-4" style={{ backgroundColor: `${colors.brand.orange}20` }}>
                  <Ionicons name="business" size={24} color={colors.brand.orange} />
                </View>
                <View className="flex-1">
                  <Text variant="body" color="primary" className="font-bold">{fleet.name}</Text>
                  <Text variant="caption" color="secondary">{fleet.contact_email}</Text>
                </View>
                <View className="px-2 py-1 rounded-full" style={{ backgroundColor: `${colors.success.DEFAULT}20` }}>
                  <Text variant="caption" style={{ color: colors.success.DEFAULT }}>
                    {t('corporate.active', { defaultValue: 'Activa' })}
                  </Text>
                </View>
              </View>
            </AnimatedCard>

            {/* Special Rates */}
            {rates.length > 0 && (
              <>
                <Text variant="label" color="secondary" className="mb-2 ml-1">
                  {t('corporate.special_rates', { defaultValue: 'Tarifas especiales' })}
                </Text>
                <View className="flex-row gap-2 mb-6 flex-wrap">
                  {rates.map((rate, i) => (
                    <View
                      key={i}
                      className="rounded-xl p-3"
                      style={{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', minWidth: '45%' }}
                    >
                      <Text variant="caption" color="secondary">{rate.service_type}</Text>
                      <Text variant="metric" color="accent">{rate.rate_multiplier}x</Text>
                      <Text variant="caption" style={{ color: colors.neutral[500] }}>{rate.description}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            {/* Corporate Rides */}
            <Text variant="label" color="secondary" className="mb-2 ml-1">
              {t('corporate.rides_section', { defaultValue: 'Viajes corporativos' })}
            </Text>
            {rides.length === 0 ? (
              <EmptyState
    
                icon="car-outline"
                title={t('corporate.no_rides', { defaultValue: 'Sin viajes corporativos' })}
                description={t('corporate.no_rides_desc', { defaultValue: 'Tus viajes corporativos aparecerán aquí.' })}
              />
            ) : (
              <StaggeredList staggerDelay={70}>
                {rides.map((ride) => (
                  <View
                    key={ride.id}
                    className="rounded-xl p-4 mb-2"
                    style={{ backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0' }}
                  >
                    <View className="flex-row items-center justify-between mb-2">
                      <View className="px-2 py-0.5 rounded-full" style={{ backgroundColor: `${colors.info.DEFAULT}20` }}>
                        <Text variant="caption" style={{ color: colors.info.DEFAULT }}>
                          {ride.corporate_account_name}
                        </Text>
                      </View>
                      <Text variant="caption" style={{ color: colors.neutral[500] }}>
                        {new Date(ride.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <View className="flex-row items-center mb-1">
                      <Ionicons name="ellipse" size={8} color={colors.success.DEFAULT} />
                      <Text variant="bodySmall" color="primary" className="ml-2" numberOfLines={1}>
                        {ride.pickup_address}
                      </Text>
                    </View>
                    <View className="flex-row items-center">
                      <Ionicons name="ellipse" size={8} color={colors.brand.orange} />
                      <Text variant="bodySmall" color="primary" className="ml-2" numberOfLines={1}>
                        {ride.dropoff_address}
                      </Text>
                    </View>
                    <Text variant="body" style={{ color: colors.success.DEFAULT, fontWeight: '700' }} className="mt-2">
                      {formatCUP(ride.fare)}
                    </Text>
                  </View>
                ))}
              </StaggeredList>
            )}
          </>
        )}
      </View>
    </Screen>
  );
}
