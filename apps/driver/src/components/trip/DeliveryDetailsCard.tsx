/**
 * DeliveryDetailsCard — extracted from DriverTripView for PR-A.
 *
 * Renders the cargo-ride recipient and package metadata: recipient name,
 * tap-to-call phone, package description + category + weight + client
 * accompaniment, and special instructions if present.
 *
 * Behavior + visuals preserved verbatim. Migration to midnightEmber
 * tokens happens in PR-B.
 */
import React from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import type { DeliveryDetails } from '@tricigo/api';

interface DeliveryDetailsCardProps {
  details: DeliveryDetails | null;
}

export function DeliveryDetailsCard({ details }: DeliveryDetailsCardProps) {
  const { t } = useTranslation('driver');
  if (!details) return null;

  return (
    <Card forceDark variant="filled" padding="md" className="bg-[#1a1a2e] mb-3 rounded-2xl border border-white/[0.06]">
      {/* Recipient */}
      <View className="flex-row items-center mb-2">
        <Ionicons name="person" size={16} color="#FF4D00" />
        <Text variant="body" color="inverse" className="ml-2 font-semibold flex-1">
          {details.recipient_name}
        </Text>
      </View>
      <Pressable
        onPress={() => Linking.openURL(`tel:${details.recipient_phone}`)}
        className="flex-row items-center mb-3 bg-neutral-700 rounded-2xl py-2 px-3"
        style={{ minHeight: 48 }}
        accessibilityRole="button"
        accessibilityLabel={`${t('delivery.tap_to_call')} ${details.recipient_phone}`}
      >
        <Ionicons name="call" size={14} color="#10B981" />
        <Text variant="bodySmall" color="inverse" className="ml-2">
          {details.recipient_phone}
        </Text>
        <Text variant="caption" color="accent" className="ml-auto">
          {t('delivery.tap_to_call')}
        </Text>
      </Pressable>

      {/* Package info */}
      <View className="mb-2">
        <Text variant="caption" color="secondary" className="mb-1">
          {t('delivery.package_description')}
        </Text>
        <Text variant="bodySmall" color="inverse">
          {details.package_description}
        </Text>
      </View>

      {/* Category + weight badges */}
      <View className="flex-row flex-wrap gap-1.5 mb-2">
        {details.package_category && (
          <View className="px-2.5 py-1 rounded-full" style={{ backgroundColor: 'rgba(255,77,0,0.2)' }}>
            <Text variant="caption" color="inverse" className="text-xs">
              {t(`delivery.cat_${details.package_category}`, { defaultValue: details.package_category })}
            </Text>
          </View>
        )}
        {details.estimated_weight_kg != null && (
          <View className="bg-neutral-700 px-2.5 py-1 rounded-full">
            <Text variant="caption" color="inverse" className="text-xs">
              {t('delivery.weight_kg', { weight: details.estimated_weight_kg })}
            </Text>
          </View>
        )}
        {details.client_accompanies && (
          <View className="bg-blue-600/20 px-2.5 py-1 rounded-full flex-row items-center gap-1">
            <Ionicons name="people" size={10} color="#60A5FA" />
            <Text variant="caption" color="inverse" className="text-xs">
              {t('delivery.client_accompanies')}
            </Text>
          </View>
        )}
      </View>

      {/* Special instructions */}
      {details.special_instructions ? (
        <View className="bg-yellow-900/20 rounded-lg p-2.5 mt-1">
          <View className="flex-row items-center mb-1">
            <Ionicons name="alert-circle" size={14} color="#F59E0B" />
            <Text variant="caption" color="inverse" className="ml-1 font-semibold">
              {t('delivery.special_instructions')}
            </Text>
          </View>
          <Text variant="bodySmall" color="inverse" className="opacity-80">
            {details.special_instructions}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
