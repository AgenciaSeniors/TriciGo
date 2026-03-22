import React, { useEffect, useRef } from 'react';
import { Animated, ViewStyle } from 'react-native';

interface AnimatedCardProps {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  className?: string;
  style?: ViewStyle;
}

/**
 * Card that fades in and slides up on mount.
 * Uses native driver for 60fps performance.
 */
export function AnimatedCard({
  children,
  delay = 0,
  duration = 400,
  className,
  style,
}: AnimatedCardProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY, delay, duration]);

  return (
    <Animated.View
      className={className}
      style={[{ opacity, transform: [{ translateY }] }, style]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Button with scale animation on press.
 */
export function AnimatedPressable({
  children,
  onPress,
  disabled,
  className,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  className?: string;
  style?: ViewStyle;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Animated.spring(scale, { toValue: 0.95, useNativeDriver: true, speed: 50 }).start();
  };

  const onPressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 50 }).start();
  };

  return (
    <Animated.View
      className={className}
      style={[{ transform: [{ scale }] }, style]}
    >
      <Animated.View>
        {React.cloneElement(children as React.ReactElement, {
          onPress,
          onPressIn,
          onPressOut,
          disabled,
        })}
      </Animated.View>
    </Animated.View>
  );
}

/**
 * Staggered list animation — each child fades in with increasing delay.
 */
export function StaggeredList({
  children,
  staggerDelay = 80,
}: {
  children: React.ReactNode[];
  staggerDelay?: number;
}) {
  return (
    <>
      {React.Children.map(children, (child, index) => (
        <AnimatedCard key={index} delay={index * staggerDelay}>
          {child}
        </AnimatedCard>
      ))}
    </>
  );
}
