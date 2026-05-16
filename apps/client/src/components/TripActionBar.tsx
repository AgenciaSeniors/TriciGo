/**
 * TripActionBar — fixed action bar for the rider's active-trip screen.
 *
 * Bug B: the rider's chat entry point used to be a small IconButton
 * buried inside DriverCard's `actions` prop, gated on `rideWithDriver`.
 * It was easy to miss and sometimes absent entirely — while the driver
 * app has a prominent, always-visible TripActionToolbar.
 *
 * This bar gives the rider parity: a fixed row of icon+caption actions
 * (Mensaje · Llamar · Seguridad) pinned between the map and the
 * scrolling panel — always visible, never scrolled away, and gated
 * only on the active ride existing (NOT on rideWithDriver loading).
 * The Chat action carries an unread badge so the rider notices when
 * the driver writes first.
 */
import React from 'react';
import { View, Pressable, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

interface TripActionBarProps {
  /** Unread messages from the driver — drives the chat badge. */
  unreadCount: number;
  /** Whether the driver's phone is known (else Call renders disabled). */
  callEnabled: boolean;
  onChat: () => void;
  onCall: () => void;
  onSafety: () => void;
}

interface BarButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  badgeCount?: number;
}

function BarButton({
  icon,
  label,
  color,
  onPress,
  accessibilityLabel,
  disabled,
  badgeCount,
}: BarButtonProps) {
  const showBadge = badgeCount != null && badgeCount > 0;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flex: 1,
        minHeight: 60,
        paddingVertical: 8,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
    >
      <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={24} color={color} />
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
      <Text
        variant="caption"
        style={{ color, fontSize: 11, marginTop: 4, fontWeight: '600' }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function TripActionBar({
  unreadCount,
  callEnabled,
  onChat,
  onCall,
  onSafety,
}: TripActionBarProps) {
  const { t } = useTranslation('rider');
  const isDark = useColorScheme() === 'dark';

  const chatLabel =
    unreadCount > 0
      ? t('ride.toolbar_chat_unread', {
          count: unreadCount,
          defaultValue: 'Chat, {{count}} sin leer',
        })
      : t('chat.title', { defaultValue: 'Chat' });

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'stretch',
        backgroundColor: isDark ? colors.neutral[900] : '#FFFFFF',
        borderBottomWidth: 1,
        borderBottomColor: isDark ? colors.neutral[800] : colors.neutral[200],
        paddingHorizontal: 8,
        // Lift the bar above the scrolling panel below it.
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: isDark ? 0.4 : 0.08,
        shadowRadius: 4,
        elevation: 4,
        zIndex: 10,
      }}
    >
      <BarButton
        icon="chatbubble-ellipses"
        label={t('ride.toolbar_chat', { defaultValue: 'Mensaje' })}
        color={colors.brand.orange}
        onPress={onChat}
        accessibilityLabel={chatLabel}
        badgeCount={unreadCount}
      />
      <BarButton
        icon="call"
        label={t('ride.toolbar_call', { defaultValue: 'Llamar' })}
        color={callEnabled ? colors.info.DEFAULT : colors.neutral[400]}
        onPress={onCall}
        accessibilityLabel={t('ride.call_driver', { defaultValue: 'Llamar' })}
        disabled={!callEnabled}
      />
      <BarButton
        icon="shield-checkmark"
        label={t('ride.toolbar_safety', { defaultValue: 'Seguridad' })}
        color={colors.error.DEFAULT}
        onPress={onSafety}
        accessibilityLabel={t('ride.safety_button', { defaultValue: 'Seguridad' })}
      />
    </View>
  );
}
