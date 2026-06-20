/**
 * RiderInfoCard — Midnight Ember edition.
 *
 * Shows WHO the driver is picking up during an active trip: avatar, name and
 * rating, with the whole card tappable to open the in-app chat. Until now the
 * driver never saw the passenger's identity once a ride was accepted (name /
 * avatar / rating only appeared in the pre-accept request card and in the
 * post-trip rating sheet) — at the curb there was no way to confirm who to
 * pick up. Mirrors the structure + `midnightEmber.*` tokens of
 * DeliveryDetailsCard so it reads as part of the same sheet.
 *
 * Data comes from `rideService.getRideWithRider` (RLS-safe, membership-gated
 * RPC `get_ride_party_profiles`). That RPC does NOT expose the rider's phone,
 * so contact is via chat. A direct-call button is a deliberate future
 * follow-up: it needs a backend RPC to surface the rider's phone to the
 * assigned driver (privacy + security review). The card is built so a call
 * action can slot in next to the chat affordance without restructuring.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Avatar } from '@tricigo/ui/Avatar';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';
import { formatRating } from '@tricigo/utils';

interface RiderInfoCardProps {
  riderName: string;
  riderAvatarUrl: string | null;
  riderRating: number | null;
  rideId: string;
}

export function RiderInfoCard({
  riderName,
  riderAvatarUrl,
  riderRating,
  rideId,
}: RiderInfoCardProps) {
  const { t } = useTranslation('driver');

  return (
    <Pressable
      onPress={() => router.push(`/chat/${rideId}`)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: midnightEmber.map.bg.elevated,
        borderColor: midnightEmber.map.line.hairline,
        borderWidth: 1,
        borderRadius: midnightEmber.radius.card,
        padding: 12,
        marginBottom: 12,
      }}
      accessibilityRole="button"
      accessibilityLabel={t('trip.rider_card_a11y', {
        name: riderName,
        defaultValue: `Pasajero ${riderName}. Tocá para abrir el chat.`,
      })}
    >
      <Avatar uri={riderAvatarUrl} size={44} name={riderName} />

      <View style={{ flex: 1 }}>
        <Text
          variant="body"
          numberOfLines={1}
          style={{ color: midnightEmber.map.text.primary, fontWeight: '700' }}
        >
          {riderName}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          <Ionicons name="star" size={12} color={midnightEmber.accent[500]} />
          <Text variant="caption" style={{ color: midnightEmber.map.text.secondary }}>
            {formatRating(riderRating, t('rating_new', { ns: 'common', defaultValue: 'Nuevo' }))}
          </Text>
        </View>
      </View>

      {/* Chat affordance — the whole card opens the chat; this keeps the
          action discoverable. A future "Llamar" button slots in here. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: midnightEmber.map.bg.surface,
          borderRadius: midnightEmber.radius.input,
          paddingVertical: 8,
          paddingHorizontal: 12,
          minHeight: 40,
        }}
      >
        <Ionicons name="chatbubble" size={14} color={midnightEmber.accent[500]} />
        <Text variant="caption" style={{ color: midnightEmber.accent[500] }}>
          {t('trip.toolbar_chat', { defaultValue: 'Chat' })}
        </Text>
      </View>
    </Pressable>
  );
}
