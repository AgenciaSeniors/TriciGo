/**
 * TripStepper — extracted from DriverTripView for PR-A.
 *
 * BUG-236 redesign: replaces the original 6-truncated-labels-in-a-row
 * stepper (occupied ~70pt) with 6 small dots + the current step label
 * prominently below. Driver instantly sees "where am I" instead of
 * having to read 6 labels.
 *
 * Behavior + visuals preserved verbatim. The "rainbow per status"
 * coloring (5 hex literals) is kept in this PR; collapse to a single
 * accent intensity scale happens in PR-B.
 */
import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';

export interface TripStep {
  key: string;
  label: string;
}

interface TripStepperProps {
  steps: TripStep[];
  currentStatus: string;
  /** Active dot color — currently the legacy rainbow per status. */
  activeDotColor: string;
  /** Background tint of the stepper container — also legacy rainbow. */
  tintBackground: string;
}

export function TripStepper({
  steps,
  currentStatus,
  activeDotColor,
  tintBackground,
}: TripStepperProps) {
  const currentIdx = steps.findIndex((s) => s.key === currentStatus);
  const currentLabel = steps.find((s) => s.key === currentStatus)?.label ?? '';

  return (
    <View style={{
      backgroundColor: tintBackground,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      marginTop: 4,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.06)',
    }}>
      <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginBottom: 6 }}>
        {steps.map((step, idx) => {
          const isPast = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          return (
            <View
              key={step.key}
              style={{
                width: isCurrent ? 24 : 8,
                height: 4,
                borderRadius: 2,
                backgroundColor: isCurrent
                  ? activeDotColor
                  : isPast
                    ? 'rgba(255,255,255,0.4)'
                    : 'rgba(255,255,255,0.12)',
              }}
            />
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6 }}>
        <Text variant="bodySmall" style={{ color: '#fff', fontWeight: '600' }}>
          {currentLabel}
        </Text>
        <Text variant="caption" style={{ color: 'rgba(255,255,255,0.5)' }}>
          · {currentIdx + 1}/{steps.length}
        </Text>
      </View>
    </View>
  );
}
