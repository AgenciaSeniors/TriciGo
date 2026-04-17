import React, { type ComponentProps } from 'react';
import { View, Pressable, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors } from '@tricigo/theme';

export interface MenuRowProps {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** Optional subtitle below the label */
  subtitle?: string;
  /** Optional right-side value text */
  value?: string;
  onPress?: () => void;
  /** Show a colored icon background for visual hierarchy */
  iconBg?: 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral';
  /** Show a right chevron (default: true) */
  showChevron?: boolean;
  /** Right-side custom element instead of chevron/value */
  right?: React.ReactNode;
  /** Destructive action styling */
  destructive?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Whether to show bottom border (default: true) */
  showBorder?: boolean;
  /** Force dark background mode (light text on dark bg) */
  forceDark?: boolean;
  className?: string;
}

const iconBgColors = {
  primary: { light: 'rgba(255, 77, 0, 0.10)', dark: 'rgba(255, 77, 0, 0.15)' },
  success: { light: 'rgba(16, 185, 129, 0.10)', dark: 'rgba(16, 185, 129, 0.15)' },
  warning: { light: 'rgba(245, 158, 11, 0.10)', dark: 'rgba(245, 158, 11, 0.15)' },
  error: { light: 'rgba(239, 68, 68, 0.10)', dark: 'rgba(239, 68, 68, 0.15)' },
  info: { light: 'rgba(59, 130, 246, 0.10)', dark: 'rgba(59, 130, 246, 0.15)' },
  neutral: { light: 'rgba(115, 115, 115, 0.10)', dark: 'rgba(115, 115, 115, 0.15)' },
};

const iconFgColors = {
  primary: colors.primary[500],
  success: colors.success.DEFAULT,
  warning: colors.warning.DEFAULT,
  error: colors.error.DEFAULT,
  info: colors.info.DEFAULT,
  neutral: colors.neutral[500],
};

export function MenuRow({
  icon,
  label,
  subtitle,
  value,
  onPress,
  iconBg,
  showChevron = true,
  right,
  destructive = false,
  disabled = false,
  showBorder = true,
  forceDark = false,
  className,
}: MenuRowProps) {
  const colorScheme = useColorScheme();
  const isDark = forceDark || colorScheme === 'dark';

  const iconColor = destructive
    ? colors.error.DEFAULT
    : iconBg
      ? iconFgColors[iconBg]
      : isDark ? colors.neutral[400] : colors.neutral[600];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={`flex-row items-center py-3.5 ${showBorder ? (forceDark ? 'border-b border-white/6' : 'border-b border-neutral-100 dark:border-neutral-800') : ''} ${disabled ? 'opacity-50' : ''} ${className ?? ''}`}
      style={({ pressed }) => ({
        opacity: pressed ? 0.7 : disabled ? 0.5 : 1,
      })}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {/* Icon with optional colored background */}
      {iconBg ? (
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            backgroundColor: iconBgColors[iconBg][isDark ? 'dark' : 'light'],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={20} color={iconColor} />
        </View>
      ) : (
        <View style={{ width: 24, alignItems: 'center' }}>
          <Ionicons name={icon} size={22} color={iconColor} />
        </View>
      )}

      {/* Label + optional subtitle */}
      <View className={`flex-1 ${iconBg ? 'ml-3' : 'ml-4'}`}>
        <Text
          variant="body"
          className={destructive ? 'text-red-500' : ''}
          style={!destructive && forceDark ? { color: '#f5f5f5' } : undefined}
        >
          {label}
        </Text>
        {subtitle && (
          <Text variant="caption" color="tertiary" className="mt-0.5"
            style={forceDark ? { color: colors.neutral[400] } : undefined}
          >
            {subtitle}
          </Text>
        )}
      </View>

      {/* Right side: custom element, value, or chevron */}
      {right ? (
        right
      ) : value ? (
        <Text variant="bodySmall" color="secondary" className="mr-1"
          style={forceDark ? { color: colors.neutral[400] } : undefined}
        >
          {value}
        </Text>
      ) : null}

      {showChevron && !right && (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={isDark ? colors.neutral[600] : colors.neutral[400]}
        />
      )}
    </Pressable>
  );
}
