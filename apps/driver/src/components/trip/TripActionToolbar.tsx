/**
 * TripActionToolbar — Midnight Ember edition (PR-B).
 *
 * Bottom row of icon-with-caption actions during the trip:
 *   - Maps   → opens external (Google/Apple) navigation
 *   - Guía   → starts the in-app turn-by-turn navigation
 *   - Chat   → opens the trip chat
 *   - SOS    → triggers the SOS flow (with confirmation Alert)
 *
 * Maps + Guía are hidden when in-app navigation is already active
 * (they would just restart what's running).
 *
 * v2 tokenization: collapsed 4 distinct ad-hoc colors into a clean
 * semantic palette.
 *   - Maps: `state.info` (blue, signals "external link / different app")
 *   - Guía: `accent[500]` (active brand action)
 *   - Chat: `map.text.secondary` (neutral, supportive)
 *   - SOS:  `state.danger` (only place danger is allowed)
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { openNavigation } from '@/utils/navigation';
import { midnightEmber, colors } from '@tricigo/theme';
import { useUnreadChatCount } from '@/hooks/useUnreadChatCount';

interface TripActionToolbarProps {
  navTarget: { latitude: number; longitude: number } | null;
  inAppNavActive: boolean;
  onStartInAppNav: (target: { latitude: number; longitude: number }) => void;
  onSOS: () => void;
  rideId: string;
  /** Rider phone (E.164). When present, the "Llamar" button is shown. */
  riderPhone?: string | null;
  /** Fired when the driver taps "Llamar" — opens the dialer. */
  onCallPassenger?: () => void;
}

interface ToolbarButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Unread count shown as a badge on the icon. Mirrors the rider's
   *  TripActionBar so the two toolbars read the same way. */
  badgeCount?: number;
}

function ToolbarButton({
  icon,
  label,
  color,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  badgeCount,
}: ToolbarButtonProps) {
  const showBadge = badgeCount != null && badgeCount > 0;
  return (
    <Pressable
      onPress={onPress}
      style={{
        padding: 10,
        minHeight: 56,
        minWidth: 60,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: midnightEmber.map.bg.surface,
        borderRadius: midnightEmber.radius.card,
        borderWidth: 1,
        borderColor: midnightEmber.map.line.hairline,
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      <View>
        <Ionicons name={icon} size={22} color={color} />
        {showBadge && (
          <View
            style={{
              position: 'absolute',
              top: -6,
              right: -10,
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              paddingHorizontal: 4,
              backgroundColor: colors.error.DEFAULT,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 10, fontWeight: '800' }}>
              {badgeCount > 9 ? '9+' : String(badgeCount)}
            </Text>
          </View>
        )}
      </View>
      <Text variant="caption" style={{ color, fontSize: 10, marginTop: 2 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function TripActionToolbar({
  navTarget,
  inAppNavActive,
  onStartInAppNav,
  onSOS,
  rideId,
  riderPhone,
  onCallPassenger,
}: TripActionToolbarProps) {
  const { t } = useTranslation('driver');
  const { count: unreadChatCount, markRead: markChatRead } = useUnreadChatCount(rideId ?? null);

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-around',
        // Wrap gracefully to a second line on narrow phones / large system
        // fonts instead of overflowing the row: this toolbar can show up to 5
        // buttons (Maps·Guía·Llamar·Chat·SOS) during the pickup phase.
        gap: 8,
        marginBottom: 8,
        marginTop: 4,
      }}
    >
      {navTarget && !inAppNavActive && (
        <ToolbarButton
          icon="navigate"
          label={t('trip.toolbar_maps', { defaultValue: 'Maps' })}
          color={midnightEmber.state.info}
          onPress={() => {
            AsyncStorage.setItem('preferred_nav', 'external');
            openNavigation(navTarget.latitude, navTarget.longitude);
          }}
          accessibilityLabel={t('trip.navigate', { defaultValue: 'Navegar' })}
        />
      )}
      {navTarget && !inAppNavActive && (
        <ToolbarButton
          icon="compass"
          label={t('trip.toolbar_guide', { defaultValue: 'Guía' })}
          color={midnightEmber.accent[500]}
          onPress={() => {
            AsyncStorage.setItem('preferred_nav', 'inapp');
            onStartInAppNav(navTarget);
          }}
          accessibilityLabel={t('trip.restart_nav', { defaultValue: 'Restart navigation' })}
        />
      )}
      {riderPhone && onCallPassenger && (
        <ToolbarButton
          icon="call"
          label={t('trip.toolbar_call', { defaultValue: 'Llamar' })}
          color={midnightEmber.state.info}
          onPress={onCallPassenger}
          accessibilityLabel={t('trip.call_passenger', { defaultValue: 'Llamar al pasajero' })}
        />
      )}
      <ToolbarButton
        icon="chatbubble"
        label={t('trip.toolbar_chat', { defaultValue: 'Chat' })}
        color={midnightEmber.map.text.secondary}
        onPress={() => { markChatRead(); router.push(`/chat/${rideId}`); }}
        badgeCount={unreadChatCount}
        accessibilityLabel={
          unreadChatCount > 0
            ? t('chat.toolbar_chat_unread', {
                count: unreadChatCount,
                defaultValue: 'Chat, {{count}} sin leer',
              })
            : t('chat.title', { defaultValue: 'Chat' })
        }
      />
      <ToolbarButton
        icon="alert-circle"
        label="SOS"
        color={midnightEmber.state.danger}
        onPress={onSOS}
        accessibilityLabel="SOS"
        accessibilityHint={t('trip.sos_body')}
      />
    </View>
  );
}
