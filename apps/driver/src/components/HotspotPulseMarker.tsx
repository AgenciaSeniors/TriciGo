import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';

interface Props {
  /** 0..1 — drives color from amber (low) to red (hot). */
  intensity: number;
  /** Optional label shown inside the pulse (e.g. live ride count). */
  label?: string;
}

/**
 * Animated pulse marker for the driver map demand hotspots.
 *
 * Composition:
 *   - outer expanding ring (scale 1→2.2, opacity 0.6→0) — the "pulse"
 *   - inner solid dot — a colored circle whose hue/alpha reflects intensity
 *
 * Color: hsl(`30 - 30*intensity`, 90%, 55%) → ámbar a rojo.
 *
 * Web note: Animated with `useNativeDriver` on native; on web the same
 * transforms run via JS driver (Mapbox's web PointAnnotation wraps a DOM node).
 */
export function HotspotPulseMarker({ intensity, label }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 2.2,
            duration: 1500,
            easing: Easing.out(Easing.quad),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 0,
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 1500,
            easing: Easing.out(Easing.quad),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(opacity, {
            toValue: 0.6,
            duration: 0,
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity]);

  // Color: amber (30) → red (0) depending on intensity
  const clamped = Math.max(0, Math.min(1, intensity));
  const hue = 30 - 30 * clamped;
  const fillColor = `hsl(${hue}, 90%, 55%)`;
  const ringColor = `hsl(${hue}, 90%, 50%)`;
  // Core dot size also scales a bit with intensity (18 → 26 px)
  const dotSize = 18 + Math.round(clamped * 8);

  return (
    <View
      style={{
        width: 60,
        height: 60,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Outer animated ring */}
      <Animated.View
        style={{
          position: 'absolute',
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: ringColor,
          opacity,
          transform: [{ scale }],
        }}
      />
      {/* Inner solid dot */}
      <View
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: fillColor,
          borderWidth: 2,
          borderColor: 'white',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: fillColor,
          shadowOpacity: 0.5,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
          elevation: 4,
        }}
      >
        {label ? (
          <Animated.Text
            style={{
              color: 'white',
              fontSize: 10,
              fontWeight: '700',
            }}
            numberOfLines={1}
          >
            {label}
          </Animated.Text>
        ) : null}
      </View>
    </View>
  );
}
