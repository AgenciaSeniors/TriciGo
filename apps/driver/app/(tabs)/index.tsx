import React, { useCallback, useState } from 'react';
import { View, Pressable, FlatList, Alert } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api';
import { HAVANA_CENTER } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverRideStore } from '@/stores/ride.store';
import {
  useDriverRideInit,
  useIncomingRequests,
  useDriverRideActions,
} from '@/hooks/useDriverRide';
import { IncomingRideCard } from '@/components/IncomingRideCard';
import { DriverTripView } from '@/components/DriverTripView';
import type { Ride } from '@tricigo/types';

export default function DriverHomeScreen() {
  const { t } = useTranslation('driver');
  const { profile, isOnline, setOnline } = useDriverStore();
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const incomingRequests = useDriverRideStore((s) => s.incomingRequests);
  const [toggling, setToggling] = useState(false);

  // Init: check for active trip on mount
  useDriverRideInit();

  // Subscribe to incoming requests when online
  useIncomingRequests(isOnline && !activeTrip);

  const { acceptRide } = useDriverRideActions();

  const handleToggleOnline = useCallback(async () => {
    if (!profile) return;
    setToggling(true);
    try {
      const newStatus = !isOnline;
      await driverService.setOnlineStatus(
        profile.id,
        newStatus,
        newStatus ? HAVANA_CENTER : undefined,
      );
      setOnline(newStatus);
    } catch {
      Alert.alert('Error', 'No se pudo cambiar el estado');
    } finally {
      setToggling(false);
    }
  }, [profile, isOnline, setOnline]);

  const handleAccept = useCallback(
    (rideId: string) => {
      acceptRide(rideId);
    },
    [acceptRide],
  );

  const renderRequest = useCallback(
    ({ item }: { item: Ride }) => (
      <IncomingRideCard ride={item} onAccept={handleAccept} />
    ),
    [handleAccept],
  );

  // Active trip view
  if (activeTrip) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <View className="pt-4 flex-1">
          <Header isOnline={isOnline} />
          <DriverTripView />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 flex-1">
        <Header isOnline={isOnline} />

        {/* Online/Offline toggle */}
        <Pressable
          className={`
            w-full py-5 rounded-2xl items-center justify-center mb-6
            ${isOnline ? 'bg-error' : 'bg-primary-500'}
            ${toggling ? 'opacity-50' : ''}
          `}
          onPress={handleToggleOnline}
          disabled={toggling}
        >
          <Text variant="h4" color="inverse">
            {isOnline ? t('home.go_offline') : t('home.go_online')}
          </Text>
        </Pressable>

        {/* Content based on online state */}
        {isOnline ? (
          incomingRequests.length > 0 ? (
            <View className="flex-1">
              <Text variant="label" color="inverse" className="mb-3 opacity-70">
                {t('home.incoming_rides', { defaultValue: 'Solicitudes disponibles' })}
                {' '}({incomingRequests.length})
              </Text>
              <FlatList
                data={incomingRequests}
                renderItem={renderRequest}
                keyExtractor={(item) => item.id}
                showsVerticalScrollIndicator={false}
              />
            </View>
          ) : (
            <View className="flex-1 items-center justify-center">
              <Text variant="body" color="inverse" className="opacity-30">
                {t('home.waiting_requests')}
              </Text>
            </View>
          )
        ) : (
          <View className="flex-1 items-center justify-center">
            <Text variant="body" color="inverse" className="opacity-30">
              {t('home.offline')}
            </Text>
          </View>
        )}
      </View>
    </Screen>
  );
}

function Header({ isOnline }: { isOnline: boolean }) {
  const { t } = useTranslation('driver');

  return (
    <View className="flex-row items-center justify-between mb-6">
      <View>
        <Text variant="h3" color="inverse">
          Trici<Text variant="h3" color="accent">Go</Text>
        </Text>
        <Text variant="caption" color="inverse" className="opacity-50">
          Conductor
        </Text>
      </View>
      <View
        className={`px-3 py-1.5 rounded-full ${
          isOnline ? 'bg-success' : 'bg-neutral-700'
        }`}
      >
        <Text variant="caption" color="inverse">
          {isOnline ? t('home.online') : t('home.offline')}
        </Text>
      </View>
    </View>
  );
}
