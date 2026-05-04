/**
 * DeliveryDetailsCard — Midnight Ember edition (PR-B).
 *
 * Renders the cargo-ride recipient and package metadata. Behavior
 * preserved verbatim; tokens migrated to `midnightEmber.*`.
 *
 * v2 tokenization:
 *   - `<Card forceDark>` + `bg-[#1a1a2e]` legacy → raw `<View>` with
 *     `map.bg.elevated` background + `radius.card`.
 *   - Recipient pin icon: `accent[500]`.
 *   - Tap-to-call CTA: `map.bg.surface` background + `state.success`
 *     icon (call action is positive); right-side hint uses
 *     `accent[500]`.
 *   - Category chip: `accent[200]` (was `rgba(255,77,0,0.2)`).
 *   - Weight chip: `map.bg.surface` (was `bg-neutral-700`).
 *   - "Cliente acompaña" chip: `state.info` family @ 20%.
 *   - Special instructions banner: `state.warning` family.
 */
import React from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import type { DeliveryDetails } from '@tricigo/api';
import { midnightEmber } from '@tricigo/theme';

interface DeliveryDetailsCardProps {
  details: DeliveryDetails | null;
}

/** Append `33` (≈20% alpha) to a hex color so it reads as a faint tint. */
function tinted(color: string, alpha: '20' | '33' = '33'): string {
  return `${color}${alpha}`;
}

export function DeliveryDetailsCard({ details }: DeliveryDetailsCardProps) {
  const { t } = useTranslation('driver');
  if (!details) return null;

  return (
    <View
      style={{
        backgroundColor: midnightEmber.map.bg.elevated,
        borderColor: midnightEmber.map.line.hairline,
        borderWidth: 1,
        borderRadius: midnightEmber.radius.card,
        padding: 14,
        marginBottom: 12,
      }}
    >
      {/* Recipient */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <Ionicons name="person" size={16} color={midnightEmber.accent[500]} />
        <Text
          variant="body"
          style={{
            marginLeft: 8,
            flex: 1,
            color: midnightEmber.map.text.primary,
            fontWeight: '600',
          }}
        >
          {details.recipient_name}
        </Text>
      </View>
      <Pressable
        onPress={() => Linking.openURL(`tel:${details.recipient_phone}`)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginBottom: 12,
          backgroundColor: midnightEmber.map.bg.surface,
          borderRadius: midnightEmber.radius.input,
          paddingVertical: 8,
          paddingHorizontal: 12,
          minHeight: 48,
        }}
        accessibilityRole="button"
        accessibilityLabel={`${t('delivery.tap_to_call')} ${details.recipient_phone}`}
      >
        <Ionicons name="call" size={14} color={midnightEmber.state.success} />
        <Text
          variant="bodySmall"
          style={{ marginLeft: 8, color: midnightEmber.map.text.primary }}
        >
          {details.recipient_phone}
        </Text>
        <Text
          variant="caption"
          style={{ marginLeft: 'auto', color: midnightEmber.accent[500] }}
        >
          {t('delivery.tap_to_call')}
        </Text>
      </Pressable>

      {/* Package info */}
      <View style={{ marginBottom: 8 }}>
        <Text
          variant="caption"
          style={{ color: midnightEmber.map.text.tertiary, marginBottom: 2 }}
        >
          {t('delivery.package_description')}
        </Text>
        <Text
          variant="bodySmall"
          style={{ color: midnightEmber.map.text.primary }}
        >
          {details.package_description}
        </Text>
      </View>

      {/* Category + weight badges */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {details.package_category && (
          <View
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: midnightEmber.radius.pill,
              backgroundColor: midnightEmber.accent[200],
            }}
          >
            <Text
              variant="caption"
              style={{ color: midnightEmber.accent[800] }}
            >
              {t(`delivery.cat_${details.package_category}`, { defaultValue: details.package_category })}
            </Text>
          </View>
        )}
        {details.estimated_weight_kg != null && (
          <View
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: midnightEmber.radius.pill,
              backgroundColor: midnightEmber.map.bg.surface,
              borderWidth: 1,
              borderColor: midnightEmber.map.line.default,
            }}
          >
            <Text
              variant="caption"
              style={{ color: midnightEmber.map.text.secondary }}
            >
              {t('delivery.weight_kg', { weight: details.estimated_weight_kg })}
            </Text>
          </View>
        )}
        {details.client_accompanies && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: midnightEmber.radius.pill,
              backgroundColor: tinted(midnightEmber.state.info, '20'),
            }}
          >
            <Ionicons name="people" size={10} color={midnightEmber.state.info} />
            <Text
              variant="caption"
              style={{ color: midnightEmber.state.info }}
            >
              {t('delivery.client_accompanies')}
            </Text>
          </View>
        )}
      </View>

      {/* Special instructions */}
      {details.special_instructions ? (
        <View
          style={{
            marginTop: 4,
            padding: 10,
            borderRadius: midnightEmber.radius.input,
            backgroundColor: tinted(midnightEmber.state.warning, '20'),
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <Ionicons
              name="alert-circle"
              size={14}
              color={midnightEmber.state.warning}
            />
            <Text
              variant="caption"
              style={{
                marginLeft: 4,
                color: midnightEmber.state.warning,
                fontWeight: '600',
              }}
            >
              {t('delivery.special_instructions')}
            </Text>
          </View>
          <Text
            variant="bodySmall"
            style={{ color: midnightEmber.map.text.primary, opacity: 0.9 }}
          >
            {details.special_instructions}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
