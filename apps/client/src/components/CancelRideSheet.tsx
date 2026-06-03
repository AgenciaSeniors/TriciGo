import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import type { CancellationRatingImpact } from '@tricigo/types';

interface CancelRideSheetProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  /** Whether cancel is in progress */
  isLoading: boolean;
  /** Projected rating impact of cancelling now (stars, not money) */
  ratingImpact?: CancellationRatingImpact | null;
  /** Current ride status for emotional driver context */
  rideStatus?: string | null;
}

function formatStars(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(1) : '—';
}

function CancelRideSheetInner({
  visible,
  onClose,
  onConfirm,
  isLoading,
  ratingImpact,
  rideStatus,
}: CancelRideSheetProps) {
  const { t } = useTranslation('rider');

  // Haptic warning on open
  useEffect(() => {
    if (visible) triggerHaptic('warning');
  }, [visible]);

  const willPenalize = !!ratingImpact?.rating_penalized;
  const hasStarFigures =
    typeof ratingImpact?.stars_before === 'number' &&
    typeof ratingImpact?.stars_after === 'number';

  const handleConfirm = () => {
    onConfirm('user_canceled');
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {/* Header */}
      <View className="flex-row items-center mb-4">
        <Ionicons name="warning" size={24} color={colors.warning.DEFAULT} />
        <Text variant="h4" className="ml-2">
          {t('ride.cancel_title', { defaultValue: 'Cancelar viaje' })}
        </Text>
      </View>

      {/* Emotional driver context */}
      {rideStatus === 'driver_en_route' && (
        <View className="rounded-xl px-4 py-3 mb-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700">
          <View className="flex-row items-center">
            <Ionicons name="car" size={18} color={colors.warning.DEFAULT} />
            <Text variant="body" className="ml-2 text-amber-800 dark:text-amber-200 font-medium">
              {t('ride.cancel_driver_coming', { defaultValue: 'Tu conductor viene en camino' })}
            </Text>
          </View>
        </View>
      )}
      {rideStatus === 'arrived_at_pickup' && (
        <View className="rounded-xl px-4 py-3 mb-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700">
          <View className="flex-row items-center">
            <Ionicons name="location" size={18} color={colors.warning.DEFAULT} />
            <Text variant="body" className="ml-2 text-amber-800 dark:text-amber-200 font-medium">
              {t('ride.cancel_driver_waiting', { defaultValue: 'Tu conductor te está esperando' })}
            </Text>
          </View>
        </View>
      )}

      {/* Rating impact (replaces the old money fee block) */}
      {willPenalize ? (
        <View className="rounded-xl px-4 py-3 mb-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700">
          <View className="flex-row items-center">
            <Ionicons name="star-half" size={18} color={colors.warning.DEFAULT} />
            <Text variant="h4" className="ml-2 font-bold text-amber-800 dark:text-amber-200">
              {t('ride.cancel_rating_drop', { defaultValue: 'Tu calificación bajará' })}
            </Text>
          </View>
          {hasStarFigures && (
            <View className="flex-row items-center mt-1">
              <Ionicons name="star" size={14} color={colors.warning.DEFAULT} />
              <Text variant="body" className="ml-1 text-amber-700 dark:text-amber-300 font-semibold">
                {formatStars(ratingImpact?.stars_before)}
              </Text>
              <Ionicons name="arrow-forward" size={14} color={colors.warning.DEFAULT} style={{ marginHorizontal: 6 }} />
              <Ionicons name="star" size={14} color={colors.warning.DEFAULT} />
              <Text variant="body" className="ml-1 text-amber-700 dark:text-amber-300 font-semibold">
                {formatStars(ratingImpact?.stars_after)}
              </Text>
            </View>
          )}
          <Text variant="caption" className="text-amber-600 dark:text-amber-400 mt-1">
            {t('ride.cancel_rating_caption', {
              defaultValue: 'Cancelar tarde baja tu reputación y la prioridad de tus próximos viajes.',
            })}
          </Text>
        </View>
      ) : (
        <View className="rounded-xl px-4 py-3 mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700">
          <View className="flex-row items-center">
            <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
            <Text variant="body" className="ml-2 text-green-700 dark:text-green-300 font-medium">
              {t('ride.cancel_no_penalty', { defaultValue: 'Sin penalización' })}
            </Text>
          </View>
        </View>
      )}

      {/* Action buttons */}
      <Button
        title={t('ride.cancel_confirm', { defaultValue: 'Sí, cancelar' })}
        variant="danger"
        size="lg"
        fullWidth
        onPress={handleConfirm}
        loading={isLoading}
        disabled={isLoading}
        className="mb-2"
      />
      <Button
        title={t('ride.cancel_go_back', { defaultValue: 'Mantener viaje' })}
        variant="outline"
        size="lg"
        fullWidth
        onPress={onClose}
        disabled={isLoading}
      />
    </BottomSheet>
  );
}

export const CancelRideSheet = React.memo(CancelRideSheetInner);
