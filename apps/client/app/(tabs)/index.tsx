import React from 'react';
import { View, Pressable } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';

export default function HomeScreen() {
  const { t } = useTranslation('rider');
  const user = useAuthStore((s) => s.user);

  return (
    <Screen bg="white" padded>
      <View className="pt-4">
        {/* Header */}
        <Text variant="h3" className="mb-1">
          {t('home.greeting', { name: user?.full_name ?? 'Viajero' })}
        </Text>

        {/* Balance */}
        <BalanceBadge
          balance={0}
          size="sm"
          className="mt-4 mb-6"
        />

        {/* Destination search */}
        <Pressable
          className="bg-neutral-100 rounded-xl px-4 py-4 flex-row items-center mb-6"
          onPress={() => {
            // TODO: Navigate to search destination
          }}
        >
          <View className="w-3 h-3 rounded-full bg-primary-500 mr-3" />
          <Text variant="body" color="tertiary">
            {t('home.where_to')}
          </Text>
        </Pressable>

        {/* Service types */}
        <Text variant="h4" className="mb-3">
          Servicios
        </Text>
        <View className="flex-row gap-3">
          {[
            { key: 'triciclo_basico', icon: '🛺' },
            { key: 'moto_standard', icon: '🏍️' },
            { key: 'auto_standard', icon: '🚗' },
          ].map((service) => (
            <Card
              key={service.key}
              variant="outlined"
              padding="md"
              className="flex-1 items-center"
            >
              <Text variant="h3" className="mb-1">
                {service.icon}
              </Text>
              <Text variant="caption" color="secondary" className="text-center">
                {t(`service_type.${service.key}` as const)}
              </Text>
            </Card>
          ))}
        </View>

        {/* Map placeholder */}
        <Card
          variant="filled"
          padding="lg"
          className="mt-6 items-center justify-center h-48"
        >
          <Text variant="body" color="tertiary">
            Mapa (Mapbox)
          </Text>
          <Text variant="caption" color="tertiary" className="mt-1">
            Se integrará en Sprint 4
          </Text>
        </Card>

        {/* Request ride button */}
        <Button
          title={t('ride.request')}
          size="lg"
          fullWidth
          className="mt-6"
          disabled
        />
      </View>
    </Screen>
  );
}
