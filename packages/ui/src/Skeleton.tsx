import React, { useEffect, useRef } from 'react';
import { View, Animated, ViewStyle } from 'react-native';

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  className?: string;
  style?: ViewStyle;
}

/**
 * Animated skeleton placeholder for loading states.
 * Pulses between 30% and 70% opacity.
 */
export function Skeleton({
  width = '100%',
  height = 16,
  borderRadius = 8,
  className,
  style,
}: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View
      className={className}
      style={[
        {
          width: width as any,
          height,
          borderRadius,
          backgroundColor: '#252540',
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Skeleton for a card with title + 2-3 lines */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <View className="bg-neutral-100 dark:bg-neutral-800 rounded-xl p-4 mb-3">
      <Skeleton width="40%" height={14} className="mb-3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} height={12} className="mb-2" />
      ))}
    </View>
  );
}

/** Skeleton for a list item (icon + text + value) */
export function SkeletonListItem() {
  return (
    <View className="flex-row items-center py-3 border-b border-neutral-100 dark:border-neutral-800">
      <Skeleton width={40} height={40} borderRadius={20} />
      <View className="flex-1 ml-3">
        <Skeleton width="70%" height={14} className="mb-1" />
        <Skeleton width="40%" height={10} />
      </View>
      <Skeleton width={60} height={14} />
    </View>
  );
}

/** Skeleton for balance badge */
export function SkeletonBalance() {
  return (
    <View className="bg-primary-50 dark:bg-neutral-800 rounded-2xl p-5 mb-6">
      <Skeleton width="30%" height={12} className="mb-2" />
      <Skeleton width="50%" height={28} className="mb-1" />
      <Skeleton width="35%" height={10} />
    </View>
  );
}
