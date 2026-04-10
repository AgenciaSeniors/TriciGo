import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

interface TypingIndicatorProps {
  theme?: 'light' | 'dark';
}

export function TypingIndicator({ theme = 'dark' }: TypingIndicatorProps) {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const createDotAnimation = (anim: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 300, useNativeDriver: true }),
          Animated.delay(600 - delay),
        ]),
      );

    const a1 = createDotAnimation(dot1, 0);
    const a2 = createDotAnimation(dot2, 200);
    const a3 = createDotAnimation(dot3, 400);

    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

  const isDark = theme === 'dark';

  return (
    <View style={[styles.container, { alignItems: 'flex-start' }]}>
      <View style={[styles.bubble, isDark ? styles.bubbleDark : styles.bubbleLight]}>
        {[dot1, dot2, dot3].map((anim, index) => (
          <Animated.View
            key={index}
            style={[
              styles.dot,
              { backgroundColor: isDark ? 'rgba(255,255,255,0.4)' : '#9CA3AF' },
              {
                transform: [{
                  translateY: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -6],
                  }),
                }],
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    borderBottomLeftRadius: 4,
    gap: 4,
  },
  bubbleDark: {
    backgroundColor: '#1c1c24',
  },
  bubbleLight: {
    backgroundColor: '#E5E7EB',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
});
