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
import { midnightEmber } from '@tricigo/theme';

interface TripActionToolbarProps {
  navTarget: { latitude: number; longitude: number } | null;
  inAppNavActive: boolean;
  onStartInAppNav: (target: { latitude: number; longitude: number }) => void;
  onSOS: () => void;
  rideId: string;
}

interface ToolbarButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}

function ToolbarButton({
  icon,
  label,
  color,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: ToolbarButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        padding: 10,
        minHeight: 56,
        minWidth: 56,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      <Ionicons name={icon} size={22} color={color} />
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
}: TripActionToolbarProps) {
  const { t } = useTranslation('driver');

  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-around',
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
      <ToolbarButton
        icon="chatbubble"
        label={t('trip.toolbar_chat', { defaultValue: 'Chat' })}
        color={midnightEmber.map.text.secondary}
        onPress={() => router.push(`/chat/${rideId}`)}
        accessibilityLabel={t('chat.title', { defaultValue: 'Chat' })}
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
