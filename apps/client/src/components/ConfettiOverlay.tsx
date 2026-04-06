import React, { useEffect, useRef, useMemo } from 'react';
import { View, Animated, Dimensions, StyleSheet } from 'react-native';

const COLORS = ['#FF4D00', '#FFB347', '#22C55E', '#3B82F6', '#A855F7', '#EC4899'];
const PARTICLE_COUNT = 30;
const DURATION = 3000;

interface Particle {
  x: Animated.Value;
  y: Animated.Value;
  rotate: Animated.Value;
  opacity: Animated.Value;
  color: string;
  size: number;
}

export function ConfettiOverlay() {
  const { width, height } = Dimensions.get('window');

  const particles = useMemo<Particle[]>(() => {
    return Array.from({ length: PARTICLE_COUNT }, () => ({
      x: new Animated.Value(width / 2 + (Math.random() - 0.5) * 60),
      y: new Animated.Value(height * 0.6),
      rotate: new Animated.Value(0),
      opacity: new Animated.Value(1),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: 4 + Math.random() * 6,
    }));
  }, []);

  useEffect(() => {
    const animations = particles.map((p) => {
      const targetX = (Math.random() - 0.5) * width * 0.8;
      const peakY = -(height * 0.3 + Math.random() * height * 0.2);
      const landY = height * 0.3 + Math.random() * height * 0.4;

      return Animated.parallel([
        // Horizontal spread
        Animated.timing(p.x, {
          toValue: width / 2 + targetX,
          duration: DURATION,
          useNativeDriver: true,
        }),
        // Vertical: launch up then fall down (use sequence for gravity effect)
        Animated.sequence([
          Animated.timing(p.y, {
            toValue: height * 0.6 + peakY,
            duration: DURATION * 0.35,
            useNativeDriver: true,
          }),
          Animated.timing(p.y, {
            toValue: height * 0.6 + landY,
            duration: DURATION * 0.65,
            useNativeDriver: true,
          }),
        ]),
        // Rotation
        Animated.timing(p.rotate, {
          toValue: 360 + Math.random() * 720,
          duration: DURATION,
          useNativeDriver: true,
        }),
        // Fade out in last third
        Animated.sequence([
          Animated.delay(DURATION * 0.6),
          Animated.timing(p.opacity, {
            toValue: 0,
            duration: DURATION * 0.4,
            useNativeDriver: true,
          }),
        ]),
      ]);
    });

    Animated.parallel(animations).start();
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {particles.map((p, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: p.size,
            height: p.size,
            borderRadius: p.size / 2,
            backgroundColor: p.color,
            transform: [
              { translateX: p.x },
              { translateY: p.y },
              {
                rotate: p.rotate.interpolate({
                  inputRange: [0, 360],
                  outputRange: ['0deg', '360deg'],
                }),
              },
            ],
            opacity: p.opacity,
          }}
        />
      ))}
    </View>
  );
}
