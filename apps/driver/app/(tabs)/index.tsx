import React from 'react';
import { View, Pressable } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { useDriverStore } from '@/stores/driver.store';

export default function DriverHomeScreen() {
  const { t } = useTranslation('driver');
  const { isOnline, setOnline } = useDriverStore();

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 flex-1">
        {/* Header */}
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

        {/* Online/Offline toggle */}
        <Pressable
          className={`
            w-full py-5 rounded-2xl items-center justify-center mb-6
            ${isOnline ? 'bg-error' : 'bg-primary-500'}
          `}
          onPress={() => setOnline(!isOnline)}
        >
          <Text variant="h4" color="inverse">
            {isOnline ? t('home.go_offline') : t('home.go_online')}
          </Text>
        </Pressable>

        {/* Map placeholder */}
        <Card
          variant="filled"
          padding="lg"
          className="flex-1 items-center justify-center bg-neutral-800 min-h-[200px]"
        >
          <Text variant="body" color="inverse" className="opacity-50">
            Mapa (Mapbox)
          </Text>
          {isOnline && (
            <Text variant="caption" color="inverse" className="mt-2 opacity-30">
              {t('home.waiting_requests')}
            </Text>
          )}
        </Card>
      </View>
    </Screen>
  );
}
