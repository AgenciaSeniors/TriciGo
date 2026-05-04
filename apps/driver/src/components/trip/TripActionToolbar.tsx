/**
 * TripActionToolbar — extracted from DriverTripView for PR-A.
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
 * Behavior + visuals preserved verbatim. Tokens migrated in PR-B.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { openNavigation } from '@/utils/navigation';

interface TripActionToolbarProps {
  navTarget: { latitude: number; longitude: number } | null;
  inAppNavActive: boolean;
  onStartInAppNav: (target: { latitude: number; longitude: number }) => void;
  onSOS: () => void;
  rideId: string;
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
    <View style={{
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginBottom: 8,
      marginTop: 4,
    }}>
      {navTarget && !inAppNavActive && (
        <Pressable
          onPress={() => {
            AsyncStorage.setItem('preferred_nav', 'external');
            openNavigation(navTarget.latitude, navTarget.longitude);
          }}
          style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={t('trip.navigate', { defaultValue: 'Navegar' })}
        >
          <Ionicons name="navigate" size={22} color="#60A5FA" />
          <Text variant="caption" style={{ color: '#60A5FA', fontSize: 10, marginTop: 2 }}>
            {t('trip.toolbar_maps', { defaultValue: 'Maps' })}
          </Text>
        </Pressable>
      )}
      {navTarget && !inAppNavActive && (
        <Pressable
          onPress={() => {
            AsyncStorage.setItem('preferred_nav', 'inapp');
            onStartInAppNav(navTarget);
          }}
          style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={t('trip.restart_nav', { defaultValue: 'Restart navigation' })}
        >
          <Ionicons name="compass" size={22} color="#FF4D00" />
          <Text variant="caption" style={{ color: '#FF4D00', fontSize: 10, marginTop: 2 }}>
            {t('trip.toolbar_guide', { defaultValue: 'Guía' })}
          </Text>
        </Pressable>
      )}
      <Pressable
        onPress={() => router.push(`/chat/${rideId}`)}
        style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
        accessibilityRole="button"
        accessibilityLabel={t('chat.title', { defaultValue: 'Chat' })}
      >
        <Ionicons name="chatbubble" size={22} color="#9CA3AF" />
        <Text variant="caption" style={{ color: '#9CA3AF', fontSize: 10, marginTop: 2 }}>
          {t('trip.toolbar_chat', { defaultValue: 'Chat' })}
        </Text>
      </Pressable>
      <Pressable
        onPress={onSOS}
        style={{ padding: 10, minHeight: 56, minWidth: 56, alignItems: 'center', justifyContent: 'center' }}
        accessibilityRole="button"
        accessibilityLabel="SOS"
        accessibilityHint={t('trip.sos_body')}
      >
        <Ionicons name="alert-circle" size={22} color="#EF4444" />
        <Text variant="caption" style={{ color: '#EF4444', fontSize: 10, marginTop: 2 }}>
          SOS
        </Text>
      </Pressable>
    </View>
  );
}
