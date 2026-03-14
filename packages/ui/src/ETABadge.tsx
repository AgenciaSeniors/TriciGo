import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';

export interface ETABadgeProps {
  /** ETA label text (e.g. "Llega en ~5 min") */
  label: string;
  /** Whether ETA is being recalculated */
  isCalculating?: boolean;
  /** Pulse animation when ETA < 3 min */
  urgent?: boolean;
  /** Visual variant */
  variant?: 'light' | 'dark';
  className?: string;
}

export function ETABadge({
  label,
  isCalculating = false,
  urgent = false,
  variant = 'light',
  className,
}: ETABadgeProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

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

  const isDark = variant === 'dark';
  const bgClass = isDark ? 'bg-neutral-700' : 'bg-primary-50';
  const iconColor = isDark ? '#f97316' : '#ea580c'; // orange-500 / orange-600
  const textColorProp = isDark ? 'inverse' : 'primary';

  return (
    <Animated.View
      accessible
      accessibilityRole="timer"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{ transform: [{ scale: pulseAnim }] }}
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
