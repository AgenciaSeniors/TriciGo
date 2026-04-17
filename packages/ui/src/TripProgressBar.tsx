import React, { useEffect, useRef } from 'react';
import { View, Animated, Easing, StyleSheet } from 'react-native';
import { Text } from './Text';

export interface TripProgressBarProps {
  /** Progress percentage (0-100) */
  progressPercent: number;
  /** Pre-formatted distance remaining, e.g. "3.2" */
  distanceRemainingKm: string;
  /** Estimated minutes to arrival, null when unknown */
  etaMinutes: number | null;
  /** Formatted arrival time string, e.g. "3:45pm" */
  arrivalTime: string | null;
  /** Show calculating pulse animation on the filled bar */
  isCalculating?: boolean;
  /** Label for distance remaining, e.g. "3.2 km restantes" */
  distanceLabel?: string;
  /** Label for ETA, e.g. "~8 min" */
  etaLabel?: string;
  /** Label for arrival time, e.g. "Llegas ~3:45pm" */
  arrivalLabel?: string;
}

const FILL_COLOR = '#0EA5E9';
const TRACK_COLOR = '#E5E7EB';
const TEXT_PRIMARY = '#1F2937';
const TEXT_SECONDARY = '#6B7280';

/**
 * Uber-style horizontal trip progress bar.
 * Displays animated progress, distance remaining, ETA, and arrival time.
 */
export function TripProgressBar({
  progressPercent,
  distanceRemainingKm,
  etaMinutes,
  arrivalTime,
  isCalculating = false,
  distanceLabel: distanceLabelProp,
  etaLabel: etaLabelProp,
  arrivalLabel: arrivalLabelProp,
}: TripProgressBarProps) {

  // Clamp progress between 0 and 100
  const clampedProgress = Math.max(0, Math.min(100, progressPercent));

  // Animated value for smooth progress bar width transitions
  const progressAnim = useRef(new Animated.Value(clampedProgress)).current;
  // Animated value for calculating pulse opacity
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Animate progress bar width with spring physics
  useEffect(() => {
    Animated.spring(progressAnim, {
      toValue: clampedProgress,
      tension: 40,
      friction: 12,
      useNativeDriver: false, // width percentage requires layout, cannot use native driver
    }).start();
  }, [clampedProgress, progressAnim]);

  // Pulse animation when calculating
  useEffect(() => {
    if (isCalculating) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.4,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isCalculating, pulseAnim]);

  // Interpolate progress 0-100 into "0%" - "100%" string
  const widthInterpolation = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
    extrapolate: 'clamp',
  });

  const distanceLabel = distanceLabelProp ?? `${distanceRemainingKm} km`;
  const etaLabel = etaLabelProp ?? (etaMinutes != null ? `~${etaMinutes} min` : null);
  const arrivalLabel = arrivalLabelProp ?? (arrivalTime != null ? `~${arrivalTime}` : null);

  return (
    <View
      style={styles.container}
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{
        min: 0,
        max: 100,
        now: clampedProgress,
      }}
    >
      {/* Row 1: progress bar + percentage */}
      <View style={styles.barRow}>
        <View style={styles.track}>
          <Animated.View
            style={[
              styles.fill,
              {
                width: widthInterpolation,
                opacity: pulseAnim,
              },
            ]}
          />
        </View>
        <Text style={styles.percentText}>
          {Math.round(clampedProgress)}%
        </Text>
      </View>

      {/* Row 2: distance remaining + ETA */}
      <View style={styles.infoRow}>
        <Text style={styles.distanceText}>{distanceLabel}</Text>
        {etaLabel != null && (
          <Text style={styles.etaText}>{etaLabel}</Text>
        )}
      </View>

      {/* Row 3: arrival time, right-aligned */}
      {arrivalLabel != null && (
        <View style={styles.arrivalRow}>
          <Text style={styles.arrivalText}>{arrivalLabel}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: TRACK_COLOR,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: FILL_COLOR,
  },
  percentText: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  distanceText: {
    fontSize: 13,
    fontWeight: '400',
    color: TEXT_SECONDARY,
  },
  etaText: {
    fontSize: 13,
    fontWeight: '600',
    color: TEXT_PRIMARY,
  },
  arrivalRow: {
    alignItems: 'flex-end',
    marginTop: 2,
  },
  arrivalText: {
    fontSize: 12,
    fontWeight: '400',
    color: TEXT_SECONDARY,
  },
});
