// ============================================================
// TriciGo Driver — Corporate / Fleet entry point (Phase 4)
// Three states for the logged-in driver:
//   1. Belongs to one or more fleets (auto-linked or manually added)
//      → show one row per fleet with status + commission info.
//   2. Is the fleet owner (registered the fleet themselves) →
//      show fleet dashboard with members list + status.
//   3. None of the above → show FleetRequestForm so the driver
//      can submit a new fleet request.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { View, RefreshControl, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { midnightEmber, cubanLight, cubanDark, colors } from '@tricigo/theme';
import { fleetService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import FleetRequestForm from '@/components/FleetRequestForm';
import FleetMembersList from '@/components/FleetMembersList';
import type { FleetMember, FleetWithMembers } from '@tricigo/types';

export default function CorporateScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const driverProfile = useDriverStore((s) => s.profile);
  const authUser = useAuthStore((s) => s.user);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [memberships, setMemberships] = useState<FleetMember[]>([]);
  const [ownedFleet, setOwnedFleet] = useState<FleetWithMembers | null>(null);
  const [version, setVersion] = useState(0);

  const fetchData = useCallback(async () => {
    if (!driverProfile?.user_id) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const [fleetMemberships, fleet] = await Promise.all([
        fleetService.getMembershipsForDriver(driverProfile.user_id),
        fleetService.getFleetByOwner(driverProfile.user_id),
      ]);
      setMemberships(fleetMemberships);
      setOwnedFleet(fleet);
    } catch (err) {
      // Keep the last good state: the membership lookup throws on failure
      // rather than reporting "no fleet".
      logger.warn('[Corporate] Failed to load fleet data', { error: String(err) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [driverProfile?.user_id]);

  useEffect(() => {
    fetchData();
  }, [fetchData, version]);

  const isOwner = !!ownedFleet;
  const isMember = memberships.length > 0 && !isOwner;
  const inSeveralFleets = memberships.length > 1;
  const noLink = !loading && !isOwner && !isMember;

  return (
    <Screen
      scroll
      bg={isDark ? 'dark' : 'white'}
      statusBarStyle={isDark ? 'light-content' : 'dark-content'}
      padded
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); fetchData(); }}
          tintColor={colors.brand.orange}
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4 pb-8">
        <ProfileScreenHeader
          title="Corporativo"
          onBack={() => router.back()}
          backAccessibilityLabel="Atrás"
        />

        {loading && (
          <View className="gap-3">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {/* Member view: one row per fleet, since a driver can be in several */}
        {isMember && (
          <Card variant="outlined" padding="lg" className="mb-4">
            <Text variant="h4" className="mb-3">
              {inSeveralFleets ? 'Tus flotas' : 'Tu flota'}
            </Text>
            <Text variant="bodySmall" color="secondary" className="mb-3">
              {inSeveralFleets
                ? `Estás vinculado como conductor en ${memberships.length} flotas. `
                : 'Estás vinculado como conductor. '}
              Tus viajes corporativos aplicarán comisión reducida automáticamente — el pasajero paga menos y tú cobras lo mismo de siempre.
            </Text>
            <View className="gap-3">
              {memberships.map((m) => (
                <View
                  key={m.fleet_id}
                  className="flex-row items-center justify-between border-t border-neutral-100 dark:border-neutral-800 pt-3"
                >
                  <View className="flex-1 mr-2">
                    <Text variant="caption" color="secondary">Registrado como</Text>
                    <Text variant="body">{m.driver_name}</Text>
                    <Text variant="bodySmall" color="secondary">{m.driver_phone}</Text>
                  </View>
                  <StatusBadge
                    label={m.status === 'active' ? 'Activo' : 'Pendiente'}
                    variant={m.status === 'active' ? 'success' : 'warning'}
                  />
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* Owner dashboard */}
        {isOwner && (
          <>
            <Card variant="outlined" padding="lg" className="mb-4">
              <View className="flex-row items-center justify-between mb-3">
                <Text variant="h4">{ownedFleet!.fleet.name}</Text>
                <StatusBadge
                  label={ownedFleet!.account.status}
                  variant={
                    ownedFleet!.account.status === 'approved'
                      ? 'success'
                      : ownedFleet!.account.status === 'rejected' || ownedFleet!.account.status === 'suspended'
                      ? 'error'
                      : 'warning'
                  }
                />
              </View>
              {ownedFleet!.account.status === 'pending' && (
                <Text variant="bodySmall" color="secondary" className="mb-3">
                  Tu flota está en revisión. Recibirás una notificación cuando el equipo TriciGo la apruebe. Los conductores listados serán vinculados automáticamente cuando se registren con su número de teléfono.
                </Text>
              )}
              {ownedFleet!.account.status === 'approved' && ownedFleet!.account.commission_percent !== null && (
                <View className="border-t border-neutral-100 dark:border-neutral-800 pt-3 mb-2">
                  <Text variant="caption" color="secondary">Comisión asignada</Text>
                  <Text variant="h4" color="accent">{ownedFleet!.account.commission_percent}%</Text>
                  <Text variant="caption" color="secondary">
                    Reducida vs. el {15}% estándar — pasajeros pagan menos.
                  </Text>
                </View>
              )}
            </Card>

            <Text variant="label" color="secondary" className="mb-2 ml-1">Conductores</Text>
            <Card variant="outlined" padding="lg" className="mb-4">
              <FleetMembersList members={ownedFleet!.members} />
            </Card>
          </>
        )}

        {/* Empty → form */}
        {noLink && driverProfile?.user_id && (
          <FleetRequestForm
            ownerUserId={driverProfile.user_id}
            ownerPhone={authUser?.phone ?? ''}
            onSubmitted={() => setVersion((v) => v + 1)}
          />
        )}
      </View>
      </View>
    </Screen>
  );
}
