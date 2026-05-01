// ============================================================
// TriciGo Driver — Corporate / Fleet entry point (Phase 4)
// Three states for the logged-in driver:
//   1. Belongs to a fleet (auto-linked or manually added) → show
//      membership card with status + commission info.
//   2. Is the fleet owner (registered the fleet themselves) →
//      show fleet dashboard with members list + status.
//   3. None of the above → show FleetRequestForm so the driver
//      can submit a new fleet request.
// ============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { colors } from '@tricigo/theme';
import { fleetService } from '@tricigo/api';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import FleetRequestForm from '@/components/FleetRequestForm';
import FleetMembersList from '@/components/FleetMembersList';
import type { FleetMember, FleetWithMembers } from '@tricigo/types';

export default function CorporateScreen() {
  const driverProfile = useDriverStore((s) => s.profile);
  const authUser = useAuthStore((s) => s.user);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [membership, setMembership] = useState<FleetMember | null>(null);
  const [ownedFleet, setOwnedFleet] = useState<FleetWithMembers | null>(null);
  const [version, setVersion] = useState(0);

  const fetchData = useCallback(async () => {
    if (!driverProfile?.user_id) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const [member, fleet] = await Promise.all([
        fleetService.getMembershipForDriver(driverProfile.user_id),
        fleetService.getFleetByOwner(driverProfile.user_id),
      ]);
      setMembership(member);
      setOwnedFleet(fleet);
    } catch {
      // silent — keep last good state
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [driverProfile?.user_id]);

  useEffect(() => {
    fetchData();
  }, [fetchData, version]);

  const isOwner = !!ownedFleet;
  const isMember = !!membership && !isOwner;
  const noLink = !loading && !isOwner && !isMember;

  return (
    <Screen
      scroll
      bg="lightPrimary"
      statusBarStyle="dark-content"
      padded
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); fetchData(); }}
          tintColor={colors.brand.orange}
        />
      }
    >
      <View className="pt-4 pb-8">
        <View className="flex-row items-center mb-6">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Atrás"
            className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
            style={{ backgroundColor: colors.neutral[100] }}
          >
            <Ionicons name="arrow-back" size={20} color={colors.neutral[800]} />
          </Pressable>
          <Text variant="h3" color="primary">Corporativo</Text>
        </View>

        {loading && (
          <View className="gap-3">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {/* Member view */}
        {isMember && (
          <Card variant="outlined" padding="lg" className="mb-4">
            <View className="flex-row items-center justify-between mb-3">
              <Text variant="h4">Tu flota</Text>
              <StatusBadge
                label={membership!.status === 'active' ? 'Activo' : 'Pendiente'}
                variant={membership!.status === 'active' ? 'success' : 'warning'}
              />
            </View>
            <Text variant="bodySmall" color="secondary" className="mb-3">
              Estás vinculado como conductor. Tus viajes corporativos aplicarán comisión reducida automáticamente — el pasajero paga menos y tú cobras lo mismo de siempre.
            </Text>
            <View className="border-t border-neutral-100 dark:border-neutral-800 pt-3">
              <Text variant="caption" color="secondary">Registrado como</Text>
              <Text variant="body">{membership!.driver_name}</Text>
              <Text variant="bodySmall" color="secondary">{membership!.driver_phone}</Text>
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
    </Screen>
  );
}
