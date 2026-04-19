/**
 * StopMarker — un solo círculo-número en estética Cuban Modern.
 *
 * Para usar en listas de paradas (RideActiveView, SelectingView) y
 * también en layers map-level si se renderiza en HTML (no en Mapbox).
 *
 * Tres estados visuales:
 *  - pending   : aún no se llegó — fondo orange, número blanco Bricolage bold.
 *  - current   : el driver va hacia acá ahora — pulse ring en orangeGlow.
 *  - completed : ya se pasó — fondo dusk, check blanco.
 *
 * Reference: docs/WAYPOINTS_REDESIGN.md §Lenguaje visual Cuban Modern.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text as RNText, Animated, StyleSheet, Easing } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';

export type StopStatus = 'pending' | 'current' | 'completed';

export interface StopMarkerProps {
  /** Número de parada (1-based, `sort_order` del backend). */
  index: number;
  status?: StopStatus;
  mode?: 'light' | 'dark';
  /** Tamaño del círculo en px. 28 default para listas, 36 para mapa. */
  size?: number;
}

export function StopMarker({
  index,
  status = 'pending',
  mode = 'light',
  size = 28,
}: StopMarkerProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  // Pulse ring animation for the current stop (next one coming up).
  useEffect(() => {
    if (status !== 'current') {
      pulseAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, pulseAnim]);

  const bgColor =
    status === 'completed' ? tokens.accent.dusk : tokens.accent.orange;
  const numberFontSize = Math.round(size * 0.46);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {status === 'current' && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pulse,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: tokens.accent.orangeGlow,
              transform: [
                {
                  scale: pulseAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 1.7],
                  }),
                },
              ],
              opacity: pulseAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [0.9, 0],
              }),
            },
          ]}
        />
      )}

      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bgColor,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 2,
          borderColor: tokens.bg.elev1,
        }}
      >
        {status === 'completed' ? (
          <Check color="#FFFFFF" size={Math.round(size * 0.5)} />
        ) : (
          <RNText
            style={{
              fontFamily: 'BricolageGrotesque_700Bold',
              fontSize: numberFontSize,
              color: '#FFFFFF',
              lineHeight: numberFontSize + 2,
            }}
          >
            {index}
          </RNText>
        )}
      </View>
    </View>
  );
}

/** Simple inline check glyph (no external icon set — tokens-only). */
function Check({ color, size }: { color: string; size: number }) {
  const stroke = Math.max(2, Math.round(size * 0.16));
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Diagonal short leg */}
      <View
        style={{
          position: 'absolute',
          width: size * 0.28,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke,
          transform: [{ rotate: '45deg' }, { translateX: -size * 0.15 }, { translateY: size * 0.08 }],
        }}
      />
      {/* Diagonal long leg */}
      <View
        style={{
          position: 'absolute',
          width: size * 0.5,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke,
          transform: [{ rotate: '-45deg' }, { translateX: size * 0.05 }, { translateY: -size * 0.02 }],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pulse: {
    position: 'absolute',
  },
});
