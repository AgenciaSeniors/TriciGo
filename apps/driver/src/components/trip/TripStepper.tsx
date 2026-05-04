/**
 * TripStepper — Midnight Ember edition (PR-B).
 *
 * BUG-236 redesign: 6 small dots + the current step label. The wide
 * "current" dot adopts the active phase color (orchestrator passes the
 * `tripPhase[status]` value); past dots use `text.tertiary`; future
 * dots use `line.default`.
 *
 * v2 tokenization:
 *   - Stepper container uses `radius.card` and a uniform tint passed in
 *     by the orchestrator (formerly a 5-rgba rainbow); border consumes
 *     `map.line.hairline`.
 *   - Past dots: `text.tertiary` (was `rgba(255,255,255,0.4)`).
 *   - Future dots: `line.default` (was `rgba(255,255,255,0.12)`).
 *   - Label colors: `map.text.primary` + `map.text.tertiary` for the
 *     `· N/M` counter.
 */
import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { midnightEmber } from '@tricigo/theme';

export interface TripStep {
  key: string;
  label: string;
}

interface TripStepperProps {
  steps: TripStep[];
  currentStatus: string;
  /** Active dot color — orchestrator passes the tripPhase token for status. */
  activeDotColor: string;
  /** Subtle tint background for the stepper container. */
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
    <View
      style={{
        backgroundColor: tintBackground,
        borderRadius: midnightEmber.radius.card,
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginTop: 4,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: midnightEmber.map.line.hairline,
      }}
    >
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
                    ? midnightEmber.map.text.tertiary
                    : midnightEmber.map.line.default,
              }}
            />
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 6 }}>
        <Text
          variant="bodySmall"
          style={{ color: midnightEmber.map.text.primary, fontWeight: '600' }}
        >
          {currentLabel}
        </Text>
        <Text
          variant="caption"
          style={{ color: midnightEmber.map.text.tertiary }}
        >
          · {currentIdx + 1}/{steps.length}
        </Text>
      </View>
    </View>
  );
}
