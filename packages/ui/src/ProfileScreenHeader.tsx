/**
 * ProfileScreenHeader — shared back-button + title row for the profile
 * sub-screens.
 *
 * Replaces the inline pattern (~10 LOC × 22 occurrences) that was
 * duplicated across `apps/driver/app/profile/*` with this single
 * reusable component.
 *
 * Visual contract — preserves the dominant pattern in those 22 files
 * verbatim (w-11 h-11 / rounded-xl / bg-neutral-100 / icon color
 * neutral-800) so the migration is zero-visual-change for the
 * vast majority of callers.
 *
 * `<ScreenHeader>` already lives in `@tricigo/ui` but uses a different
 * shape (rounded-full) + smaller touch target (w-10 h-10) suited for
 * in-app screens (chat, etc.). `<ProfileScreenHeader>` is the profile
 * sub-screen variant; both coexist intentionally.
 */
import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { colors } from '@tricigo/theme';

export interface ProfileScreenHeaderProps {
  title: string;
  onBack: () => void;
  /**
   * Optional content rendered on the right side of the row — typically
   * an action button (e.g. an "Edit" link).
   */
  rightSlot?: React.ReactNode;
  /**
   * Override the default back-button accessibility label. Callers
   * usually pass `t('common.back')` or equivalent.
   */
  backAccessibilityLabel?: string;
  /** Extra utility classes appended to the outer row. */
  className?: string;
}

export function ProfileScreenHeader({
  title,
  onBack,
  rightSlot,
  backAccessibilityLabel,
  className,
}: ProfileScreenHeaderProps) {
  return (
    <View className={`flex-row items-center mb-6 ${className ?? ''}`}>
      <Pressable
        onPress={onBack}
        hitSlop={8}
        className="mr-3 w-11 h-11 rounded-xl items-center justify-center"
        style={{ backgroundColor: colors.neutral[100] }}
        accessibilityRole="button"
        accessibilityLabel={backAccessibilityLabel ?? 'Back'}
      >
        <Ionicons name="arrow-back" size={20} color={colors.neutral[800]} />
      </Pressable>
      <View className="flex-1">
        <Text variant="h3" color="primary">
          {title}
        </Text>
      </View>
      {rightSlot && <View>{rightSlot}</View>}
    </View>
  );
}
