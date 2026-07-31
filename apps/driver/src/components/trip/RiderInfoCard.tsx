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
 * RPCs `get_ride_party_profiles` for the profile + `get_ride_contact_info`
 * for the phone). When the phone resolves (active-trip window only), a
 * "Llamar" pill sits next to the "Chat" affordance so the driver can call the
 * passenger to confirm the pickup; otherwise only Chat shows.
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
  /** Rider phone (E.164). When present, the "Llamar" pill is shown. */
  riderPhone?: string | null;
  /** Fired when the driver taps "Llamar" — opens the dialer. */
  onCall?: () => void;
}

export function RiderInfoCard({
  riderName,
  riderAvatarUrl,
  riderRating,
  rideId,
  riderPhone,
  onCall,
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
        defaultValue: `Pasajero ${riderName}. Toca para abrir el chat.`,
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

      {/* Contact actions — icon-only pills so the passenger name (the key
          "who am I picking up" info) keeps its width on narrow phones and at
          large system font sizes. The text labels live in the TripActionToolbar
          directly below. Tapping the card opens chat; the "Llamar" pill is a
          nested Pressable that claims the touch, so it dials instead. Call
          shows only when the rider phone resolved. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {riderPhone && onCall ? (
          <Pressable
            onPress={onCall}
            hitSlop={8}
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: midnightEmber.map.bg.surface,
              borderRadius: midnightEmber.radius.input,
              paddingHorizontal: 12,
              minWidth: 44,
              minHeight: 44,
            }}
            accessibilityRole="button"
            accessibilityLabel={t('trip.call_passenger', { defaultValue: 'Llamar al pasajero' })}
          >
            <Ionicons name="call" size={18} color={midnightEmber.state.info} />
          </Pressable>
        ) : null}

        {/* Chat affordance — the whole card opens the chat; this keeps the
            action discoverable. */}
        <View
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: midnightEmber.map.bg.surface,
            borderRadius: midnightEmber.radius.input,
            paddingHorizontal: 12,
            minWidth: 44,
            minHeight: 44,
          }}
          accessibilityRole="button"
          accessibilityLabel={t('trip.chat_passenger', { defaultValue: 'Chat con pasajero' })}
        >
          <Ionicons name="chatbubble" size={18} color={midnightEmber.accent[500]} />
        </View>
      </View>
    </Pressable>
  );
}
