import React, { useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import {
  type CancellationRatingImpact,
  type CancellationReasonCode,
  PASSENGER_CANCELLATION_REASONS,
  isExemptCancellationReason,
} from '@tricigo/types';

interface CancelRideSheetProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: CancellationReasonCode) => void;
  /** Whether cancel is in progress */
  isLoading: boolean;
  /** Projected rating impact of cancelling now (stars, not money). `null` means
   *  the preview couldn't be computed (transient error) — distinct from a real
   *  no-penalty result. */
  ratingImpact?: CancellationRatingImpact | null;
  /** Whether the rating-impact preview is still being fetched. */
  previewLoading?: boolean;
  /** Current ride status for emotional driver context */
  rideStatus?: string | null;
}

const REASON_LABELS: Record<CancellationReasonCode, string> = {
  changed_plans: 'Cambié de planes',
  driver_delay: 'El conductor se demora',
  wrong_price: 'El precio no es el que esperaba',
  safety: 'Me siento inseguro/a',
  other: 'Otro motivo',
  // Not offered to passengers, but typed for completeness.
  no_show: 'No apareció',
  passenger_gone: 'El pasajero no está',
  breakdown: 'Avería',
  emergency: 'Emergencia',
};

function formatStars(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(1) : '—';
}

function CancelRideSheetInner({
  visible,
  onClose,
  onConfirm,
  isLoading,
  ratingImpact,
  previewLoading,
  rideStatus,
}: CancelRideSheetProps) {
  const { t } = useTranslation('rider');
  const [reason, setReason] = useState<CancellationReasonCode | null>(null);

  // Haptic warning on open + reset the reason each time the sheet opens.
  useEffect(() => {
    if (visible) {
      triggerHaptic('warning');
      setReason(null);
    }
  }, [visible]);

  // An exempt reason (safety) overrides the projected penalty client-side, so
  // the passenger sees "no penalty" the moment they pick it — matching what the
  // server will do (migration 00486).
  const exempt = isExemptCancellationReason(reason);
  const willPenalize = !!ratingImpact?.rating_penalized && !exempt;
  const hasStarFigures =
    typeof ratingImpact?.stars_before === 'number' &&
    typeof ratingImpact?.stars_after === 'number';

  const handleConfirm = () => {
    if (!reason) return;
    onConfirm(reason);
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

      {/* Reason picker (structured — migration 00486) */}
      <Text variant="caption" color="secondary" className="mb-2">
        {t('ride.cancel_reason_label', { defaultValue: '¿Por qué cancelás?' })}
      </Text>
      <View className="mb-4">
        {PASSENGER_CANCELLATION_REASONS.map((code) => {
          const selected = reason === code;
          return (
            <Pressable
              key={code}
              onPress={() => { triggerHaptic('light'); setReason(code); }}
              disabled={isLoading}
              className={`flex-row items-center rounded-xl px-4 py-3 mb-2 border ${
                selected
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-neutral-200 dark:border-neutral-700'
              }`}
            >
              <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={selected ? colors.primary[500] : colors.neutral[400]}
              />
              <Text variant="body" className="ml-2">
                {t(`ride.cancel_reason_${code}`, { defaultValue: REASON_LABELS[code] })}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Rating impact (replaces the old money fee block). Only meaningful once
          a reason is chosen; an exempt reason flips it to "no penalty". */}
      {reason && (willPenalize ? (
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
      ) : (exempt || ratingImpact) ? (
        <View className="rounded-xl px-4 py-3 mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700">
          <View className="flex-row items-center">
            <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
            <Text variant="body" className="ml-2 text-green-700 dark:text-green-300 font-medium">
              {t('ride.cancel_no_penalty', { defaultValue: 'Sin penalización' })}
            </Text>
          </View>
        </View>
      ) : previewLoading ? null : (
        // Preview couldn't be computed (transient error). Don't claim "no
        // penalty" — the server may still apply one. Show a neutral notice.
        <View className="rounded-xl px-4 py-3 mb-4 bg-neutral-50 dark:bg-neutral-800/40 border border-neutral-200 dark:border-neutral-700">
          <View className="flex-row items-center">
            <Ionicons name="help-circle-outline" size={16} color={colors.neutral[400]} />
            <Text variant="body" className="ml-2 text-neutral-600 dark:text-neutral-300 font-medium">
              {t('ride.cancel_impact_unknown', { defaultValue: 'No pudimos calcular el impacto en tu calificación' })}
            </Text>
          </View>
        </View>
      ))}

      {/* Action buttons */}
      <Button
        title={t('ride.cancel_confirm', { defaultValue: 'Sí, cancelar' })}
        variant="danger"
        size="lg"
        fullWidth
        onPress={handleConfirm}
        loading={isLoading}
        disabled={isLoading || !reason}
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
