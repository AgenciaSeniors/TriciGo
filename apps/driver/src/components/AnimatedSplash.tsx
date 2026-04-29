import React, { useEffect, useRef } from 'react';
import {
  View,
  Image,
  Animated,
  Easing,
  StyleSheet,
  AccessibilityInfo,
  type ImageSourcePropType,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * BUG-289 — animated splash overlay (Anchor + Pulse design).
 *
 * Renders ON TOP of expo-splash-screen's native splash so the visual
 * transition from "native splash" → "JS app" is bridged by a polished,
 * branded full-screen layer:
 *
 *   1. fade in 200ms (cross-fades over the native splash)
 *   2. logo pulse — gentle scale 0.96 ↔ 1.04 (1.4s loop, ease-in-out)
 *   3. dot loader — 3 dots, staggered opacity, 600ms loop
 *   4. fades out 250ms (when `visible=false`)
 *
 * The native splash and this overlay use the same brand colors so there
 * is NO visible jump when expo-splash-screen finally calls hideAsync().
 *
 * Respects `prefers-reduced-motion`: when reduce motion is on, the pulse
 * and the dot loader skip animation and render statically.
 *
 * `tagline` defaults to "Cuba" for the client app and "Modo conductor"
 * for the driver app — pass explicitly for full control.
 */
export interface AnimatedSplashProps {
  /** When false, the overlay fades out (250ms) and unmounts. */
  visible: boolean;
  /** "client" → orange gradient, "driver" → dark slate gradient. */
  variant: 'client' | 'driver';
  /** Tagline below the loader. Default "Cuba". */
  tagline?: string;
  /** Pin foreground asset (white silhouette on transparent bg). */
  pinSource: ImageSourcePropType;
  /** Wordmark asset (white). */
  wordmarkSource: ImageSourcePropType;
}

const PALETTE = {
  client: {
    bgFrom: '#FF6A1F', // brand orange — lighter top
    bgTo: '#E84500',   // brand orange — slightly deeper bottom
    pinTint: '#FFFFFF',
    accent: '#FFFFFF',
    taglineColor: 'rgba(255,255,255,0.78)',
  },
  driver: {
    bgFrom: '#1A1A33', // dark slate (warmer than pure black)
    bgTo: '#0A0A1A',   // near black bottom
    pinTint: '#FF4D00', // brand orange pin → instant driver/client distinction
    accent: '#FF4D00',
    taglineColor: 'rgba(255,255,255,0.65)',
  },
} as const;

export function AnimatedSplash({
  visible,
  variant,
  tagline = 'Cuba',
  pinSource,
  wordmarkSource,
}: AnimatedSplashProps) {
  const palette = PALETTE[variant];

  // Top-level fade for the entire overlay (in / out).
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  // Pin pulse — looping scale.
  const pinScale = useRef(new Animated.Value(0.96)).current;
  // Three loader dots — staggered opacity loops.
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  // Reduced-motion respect — initialize once, then re-check on
  // visibility flips (the user could toggle the OS setting between).
  const reducedMotionRef = useRef(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (mounted) reducedMotionRef.current = on; })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on) => {
      reducedMotionRef.current = !!on;
    });
    return () => {
      mounted = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sub as any)?.remove?.();
    };
  }, []);

  // Drive the fade-in / fade-out + start/stop loops based on `visible`.
  useEffect(() => {
    let pinLoop: Animated.CompositeAnimation | null = null;
    let dotsLoop: Animated.CompositeAnimation | null = null;

    if (visible) {
      // Fade overlay in.
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();

      if (!reducedMotionRef.current) {
        // Pin pulse loop — gentle, 1.4s per cycle.
        pinLoop = Animated.loop(
          Animated.sequence([
            Animated.timing(pinScale, {
              toValue: 1.04,
              duration: 700,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(pinScale, {
              toValue: 0.96,
              duration: 700,
              easing: Easing.inOut(Easing.quad),
              useNativeDriver: true,
            }),
          ]),
        );
        pinLoop.start();

        // 3-dot loader — each dot pulses opacity 0.3 ↔ 1, staggered 200ms.
        const makeDot = (val: Animated.Value, delay: number) =>
          Animated.loop(
            Animated.sequence([
              Animated.delay(delay),
              Animated.timing(val, {
                toValue: 1,
                duration: 300,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
              }),
              Animated.timing(val, {
                toValue: 0.3,
                duration: 300,
                easing: Easing.in(Easing.quad),
                useNativeDriver: true,
              }),
            ]),
          );
        dotsLoop = Animated.parallel([
          makeDot(dot1, 0),
          makeDot(dot2, 200),
          makeDot(dot3, 400),
        ]);
        dotsLoop.start();
      } else {
        // Reduced-motion: hold pin at 1, dots at full opacity (no loops).
        pinScale.setValue(1);
        dot1.setValue(1);
        dot2.setValue(1);
        dot3.setValue(1);
      }
    } else {
      // Fade overlay out.
      Animated.timing(overlayOpacity, {
        toValue: 0,
        duration: 250,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start();
    }

    return () => {
      pinLoop?.stop();
      dotsLoop?.stop();
    };
  }, [visible, overlayOpacity, pinScale, dot1, dot2, dot3]);

  // Once the overlay is fully invisible, unmount (saves a layer in production).
  // We use a ref-driven mount flag so the fade-out animation completes first.
  const [shouldRender, setShouldRender] = React.useState(visible);
  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      return;
    }
    const t = setTimeout(() => setShouldRender(false), 300);
    return () => clearTimeout(t);
  }, [visible]);

  if (!shouldRender) return null;

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[StyleSheet.absoluteFillObject, { opacity: overlayOpacity, zIndex: 10000 }]}
      accessibilityRole="none"
      accessibilityLabel="TriciGo cargando"
    >
      <LinearGradient
        colors={[palette.bgFrom, palette.bgTo]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      <View style={styles.center}>
        {/* Pin (foreground silhouette tinted to variant color) */}
        <Animated.View style={{ transform: [{ scale: pinScale }] }}>
          <Image
            source={pinSource}
            resizeMode="contain"
            style={{ width: 96, height: 96, tintColor: palette.pinTint }}
            accessibilityIgnoresInvertColors
          />
        </Animated.View>

        {/* Wordmark — already white in source PNG */}
        <Image
          source={wordmarkSource}
          resizeMode="contain"
          style={{ width: 180, height: 48, marginTop: 16 }}
          accessibilityIgnoresInvertColors
        />

        {/* 3-dot loader */}
        <View style={styles.loader}>
          <Animated.View style={[styles.dot, { backgroundColor: palette.accent, opacity: dot1 }]} />
          <Animated.View style={[styles.dot, { backgroundColor: palette.accent, opacity: dot2 }]} />
          <Animated.View style={[styles.dot, { backgroundColor: palette.accent, opacity: dot3 }]} />
        </View>
      </View>

      {/* Tagline at the bottom — small, subdued, brand-anchor */}
      <View style={styles.tagline} pointerEvents="none">
        <Animated.Text
          style={{
            color: palette.taglineColor,
            fontSize: 12,
            letterSpacing: 4,
            fontWeight: '600',
            textTransform: 'uppercase',
          }}
        >
          {tagline}
        </Animated.Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loader: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 36,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tagline: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
});
