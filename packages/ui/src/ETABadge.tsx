import React, { useEffect, useRef } from 'react';
import { View, Animated, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';

export interface ETABadgeProps {
  /** ETA label text (e.g. "Llega en ~5 min") */
  label: string;
  /** Whether ETA is being recalculated */
  isCalculating?: boolean;
  /** Pulse animation when ETA < 3 min */
  urgent?: boolean;
  /**
   * Visual variant. `'auto'` (default) picks `'dark'` or `'light'` based on
   * the OS color scheme. Pass an explicit `'light'`/`'dark'` only when the
   * surrounding surface forces a specific palette.
   */
  variant?: 'light' | 'dark' | 'auto';
  className?: string;
}

export function ETABadge({
  label,
  isCalculating = false,
  urgent = false,
  variant = 'auto',
  className,
}: ETABadgeProps) {
  const colorScheme = useColorScheme();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  // UX: when ETA is being recalculated, the hourglass icon alone is too
  // subtle — riders stare at a stale number and wonder if the data froze.
  // A gentle opacity pulse on the badge says "we're still working on it"
  // without shouting. Same clarity gain as the skeleton loaders elsewhere.
  const calcOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (urgent) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.05,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [urgent, pulseAnim]);

  useEffect(() => {
    if (isCalculating) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(calcOpacity, { toValue: 0.55, duration: 700, useNativeDriver: true }),
          Animated.timing(calcOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    } else {
      calcOpacity.setValue(1);
    }
  }, [isCalculating, calcOpacity]);

  // `'auto'` follows the OS theme so a badge dropped on a dark-mode
  // surface (e.g. RideActiveView's status panel) never lands as a
  // washed-out cream pill on a near-black background. Callers can still
  // force a variant when they own the surface color directly.
  const resolvedVariant: 'light' | 'dark' =
    variant === 'auto' ? (colorScheme === 'dark' ? 'dark' : 'light') : variant;
  const isDark = resolvedVariant === 'dark';
  // Light variant uses a solid white pill with an orange hairline border
  // so the orange text + icon read at the WCAG-AA contrast level on any
  // light surface; bg-primary-50 alone was too close to the orange tones.
  const bgClass = isDark ? 'bg-neutral-700' : 'bg-white border border-primary-200';
  const iconColor = isDark ? '#f97316' : '#ea580c'; // orange-500 / orange-600
  const textColorProp = isDark ? 'inverse' : 'primary';

  return (
    <Animated.View
      accessible
      accessibilityRole="timer"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ transform: [{ scale: pulseAnim }], opacity: calcOpacity }}
      className={`flex-row items-center rounded-full px-4 py-2.5 ${bgClass} ${className ?? ''}`}
    >
      <Ionicons
        name={isCalculating ? 'hourglass-outline' : 'time-outline'}
        size={18}
        color={iconColor}
      />
      <Text
        variant="body"
        color={textColorProp}
        className="ml-2 font-semibold"
      >
        {label}
      </Text>
    </Animated.View>
  );
}
