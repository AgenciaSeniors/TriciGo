import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { colors } from '@tricigo/theme';
import { useTranslation } from '@tricigo/i18n';
import type { NavigationStep } from '@tricigo/utils';
import { getManeuverIcon, getManeuverLabel } from '@/hooks/useInAppNavigation';

interface NavigationOverlayProps {
  currentStep: NavigationStep | null;
  nextStep: NavigationStep | null;
  remainingDistance_m: number;
  remainingDuration_s: number;
  isRerouting: boolean;
  onStop: () => void;
  destinationLabel?: string;
  /** TTS voice-guidance toggle state (N1 from ride-flow review). */
  voiceEnabled?: boolean;
  onToggleVoice?: () => void;
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function NavigationOverlayInner({
  currentStep,
  nextStep,
  remainingDistance_m,
  remainingDuration_s,
  isRerouting,
  onStop,
  destinationLabel,
  voiceEnabled,
  onToggleVoice,
}: NavigationOverlayProps) {
  const { t } = useTranslation('driver');

  if (!currentStep) return null;

  let icon: string;
  let label: string;
  try {
    icon = getManeuverIcon(currentStep.maneuver_type, currentStep.maneuver_modifier) ?? 'navigate-outline';
    label = getManeuverLabel(
      currentStep.maneuver_type,
      currentStep.maneuver_modifier,
      currentStep.name,
      t as (key: string, opts?: Record<string, unknown>) => string,
      currentStep.maneuver_exit,
    ) ?? currentStep.name ?? '';
  } catch {
    icon = 'navigate-outline';
    label = currentStep.name ?? '';
  }

  // BUG-238: compact 2-line nav overlay (was 4 stacked sections ~200pt
  // dominating the bottom sheet). Now ~80pt: line 1 = current maneuver +
  // distance + total km, line 2 = next step + voice + exit. Frees up
  // ~120pt for the map. Inspired by Waze/Google Maps in-app nav strip.
  const nextStepLabel = nextStep
    ? getManeuverLabel(
        nextStep.maneuver_type,
        nextStep.maneuver_modifier,
        nextStep.name,
        t as (key: string, opts?: Record<string, unknown>) => string,
        nextStep.maneuver_exit,
      )
    : null;

  // BUG-238 fix: removed `absolute top-0` positioning. The overlay was
  // anchoring to the bottom sheet's content area (its nearest positioned
  // ancestor) and stacking ON TOP of the action button. Now it renders
  // inline in normal flow — the parent decides where to place it.
  return (
    <View className="mb-2">
      <View className="bg-neutral-900/95 rounded-2xl overflow-hidden shadow-xl">
        {/* Line 1: current maneuver + distance + remaining km/min */}
        <View className="flex-row items-center px-3 py-2.5 gap-3">
          <View className="w-9 h-9 rounded-lg bg-primary-500 items-center justify-center">
            <Ionicons name={icon as any} size={20} color="white" />
          </View>
          <View className="flex-1 flex-row items-baseline gap-2">
            <Text className="text-white text-sm font-bold flex-shrink" numberOfLines={1}>
              {label}
            </Text>
            {(currentStep.distance_m ?? 0) > 0 && (
              <Text className="text-neutral-300 text-xs">
                {formatDistance(currentStep.distance_m)}
              </Text>
            )}
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="text-primary-400 text-xs font-semibold">
              {formatDistance(remainingDistance_m)} · {formatDuration(remainingDuration_s)}
            </Text>
          </View>
        </View>

        {/* Line 2: next step + voice + exit (only when next step exists) */}
        {(nextStepLabel || isRerouting || onToggleVoice) && (
          <View className="flex-row items-center px-3 py-1.5 bg-neutral-800 gap-2">
            {nextStepLabel && (
              <>
                <Ionicons
                  name={getManeuverIcon(nextStep!.maneuver_type, nextStep!.maneuver_modifier) as any}
                  size={12}
                  color={colors.neutral[400]}
                />
                <Text className="text-neutral-400 text-xs flex-1" numberOfLines={1}>
                  {t('nav.then', { defaultValue: 'Luego:' })} {nextStepLabel}
                </Text>
              </>
            )}
            {isRerouting && (
              <Text className="text-warning text-xs flex-1" numberOfLines={1}>
                {t('nav.rerouting', { defaultValue: 'Recalculando...' })}
              </Text>
            )}
            {onToggleVoice && (
              <Pressable
                onPress={onToggleVoice}
                className="w-7 h-7 rounded-full items-center justify-center"
                accessibilityRole="button"
                accessibilityLabel={voiceEnabled ? t('nav.voice_off') : t('nav.voice_on')}
                hitSlop={8}
              >
                <Ionicons
                  name={voiceEnabled ? 'volume-high' : 'volume-mute'}
                  size={14}
                  color={voiceEnabled ? colors.primary[400] : colors.neutral[500]}
                />
              </Pressable>
            )}
            <Pressable
              onPress={onStop}
              className="px-2.5 py-1 rounded-full bg-error/20"
              accessibilityRole="button"
              accessibilityLabel={t('nav.stop', { defaultValue: 'Detener navegación' })}
              hitSlop={4}
            >
              <Text className="text-error text-xs font-bold">
                {t('nav.stop_short', { defaultValue: 'Salir' })}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

export const NavigationOverlay = React.memo(NavigationOverlayInner);
