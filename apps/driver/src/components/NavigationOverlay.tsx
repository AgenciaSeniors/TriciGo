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
    ) ?? currentStep.name ?? '';
  } catch {
    icon = 'navigate-outline';
    label = currentStep.name ?? '';
  }

  return (
    <View className="absolute top-0 left-0 right-0 z-50">
      {/* Main instruction card */}
      <View className="bg-neutral-900 mx-3 mt-3 rounded-2xl overflow-hidden shadow-xl">
        {/* Current maneuver */}
        <View className="flex-row items-center px-4 py-4 gap-4">
          <View className="w-14 h-14 rounded-xl bg-primary-500 items-center justify-center">
            <Ionicons name={icon as any} size={28} color="white" />
          </View>
          <View className="flex-1">
            <Text className="text-white text-lg font-bold" numberOfLines={2}>
              {label}
            </Text>
            {(currentStep.distance_m ?? 0) > 0 && (
              <Text className="text-neutral-400 text-sm mt-0.5">
                {formatDistance(currentStep.distance_m)}
              </Text>
            )}
          </View>
        </View>

        {/* Next step preview */}
        {nextStep && (
          <View className="flex-row items-center px-4 py-2.5 bg-neutral-800 gap-3">
            <Ionicons
              name={getManeuverIcon(nextStep.maneuver_type, nextStep.maneuver_modifier) as any}
              size={16}
              color={colors.neutral[400]}
            />
            <Text className="text-neutral-400 text-xs flex-1" numberOfLines={1}>
              {t('nav.then', { defaultValue: 'Luego:' })}{' '}
              {getManeuverLabel(
                nextStep.maneuver_type,
                nextStep.maneuver_modifier,
                nextStep.name,
                t as (key: string, opts?: Record<string, unknown>) => string,
              )}
            </Text>
          </View>
        )}

        {/* Bottom bar: remaining distance + ETA + stop button */}
        <View className="flex-row items-center justify-between px-4 py-3 bg-neutral-950">
          <View className="flex-row items-center gap-4">
            <View className="flex-row items-center gap-1.5">
              <Ionicons name="speedometer-outline" size={14} color={colors.primary[400]} />
              <Text className="text-primary-400 text-sm font-semibold">
                {formatDistance(remainingDistance_m)}
              </Text>
            </View>
            <View className="flex-row items-center gap-1.5">
              <Ionicons name="time-outline" size={14} color={colors.primary[400]} />
              <Text className="text-primary-400 text-sm font-semibold">
                {formatDuration(remainingDuration_s)}
              </Text>
            </View>
            {isRerouting && (
              <Text className="text-warning text-xs">
                {t('nav.rerouting', { defaultValue: 'Recalculando...' })}
              </Text>
            )}
          </View>
          <Pressable
            onPress={onStop}
            className="bg-error px-4 py-2 rounded-full"
            accessibilityRole="button"
            accessibilityLabel={t('nav.stop', { defaultValue: 'Detener navegación' })}
          >
            <Text className="text-white text-xs font-bold">
              {t('nav.stop_short', { defaultValue: 'Salir' })}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export const NavigationOverlay = React.memo(NavigationOverlayInner);
