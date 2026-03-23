import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { formatCUP, triggerSelection } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import type { CancellationFeePreview } from '@tricigo/types';

interface CancelRideSheetProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  /** Penalty amount in centavos that would be applied */
  penaltyAmount: number;
  /** Number of cancellations in last 24h */
  cancelCount24h: number;
  /** Whether cancel is in progress */
  isLoading: boolean;
  /** State-based cancellation fee preview */
  cancellationFee?: CancellationFeePreview | null;
}

const CANCEL_REASONS = [
  'cancel_reason_changed_mind',
  'cancel_reason_driver_late',
  'cancel_reason_mistake',
  'cancel_reason_other',
] as const;

function CancelRideSheetInner({
  visible,
  onClose,
  onConfirm,
  penaltyAmount,
  cancelCount24h,
  isLoading,
  cancellationFee,
}: CancelRideSheetProps) {
  const { t } = useTranslation('rider');
  const [selectedReason, setSelectedReason] = useState<string | null>(null);

  const hasPenalty = penaltyAmount > 0;

  const handleConfirm = () => {
    const reason = selectedReason
      ? t(`ride.${selectedReason}` as any, { defaultValue: selectedReason })
      : t('ride.cancel_reason_other', { defaultValue: 'Otra razón' });
    onConfirm(reason);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      {/* Header */}
      <View className="flex-row items-center mb-4">
        <Ionicons name="warning" size={24} color={colors.error.DEFAULT} />
        <Text variant="h4" className="ml-2">
          {t('ride.cancel_title', { defaultValue: 'Cancelar viaje' })}
        </Text>
      </View>

      {/* Cancellation policy rules */}
      <Card variant="outlined" padding="md" className="mb-4">
        <Text variant="bodySmall" className="font-semibold mb-2">
          {t('ride.cancel_policy_title', { defaultValue: 'Política de cancelación' })}
        </Text>
        <PolicyRow
          text={t('ride.cancel_policy_free', { defaultValue: '1ra cancelación del día: gratis' })}
          active={cancelCount24h === 0}
        />
        <PolicyRow
          text={t('ride.cancel_policy_second', { defaultValue: '2da cancelación: 100 CUP' })}
          active={cancelCount24h === 1}
        />
        <PolicyRow
          text={t('ride.cancel_policy_third', { defaultValue: '3ra+ cancelación: 200 CUP' })}
          active={cancelCount24h >= 2 && cancelCount24h < 4}
        />
        <PolicyRow
          text={t('ride.cancel_policy_block', { defaultValue: '5+ en 24h: bloqueo temporal' })}
          active={cancelCount24h >= 4}
        />
      </Card>

      {/* State-based cancellation fee */}
      {cancellationFee && !cancellationFee.is_free && (
        <View className="rounded-xl px-4 py-3 mb-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700">
          <View className="flex-row items-center mb-1">
            <Ionicons name="car" size={16} color={colors.warning.DEFAULT} />
            <Text variant="body" className="ml-2 font-semibold text-amber-800 dark:text-amber-200">
              {t('ride.cancel_fee_title', { defaultValue: 'Tarifa de cancelación' })}
            </Text>
          </View>
          <Text variant="bodySmall" className="text-amber-700 dark:text-amber-300 mb-1">
            {cancellationFee.fee_reason === 'driver_en_route'
              ? t('ride.cancel_fee_driver_en_route')
              : cancellationFee.fee_reason === 'driver_arrived'
                ? t('ride.cancel_fee_driver_arrived')
                : cancellationFee.fee_reason === 'ride_in_progress'
                  ? t('ride.cancel_fee_in_progress')
                  : ''}
          </Text>
          <Text variant="body" className="font-bold text-amber-900 dark:text-amber-100">
            {t('ride.cancel_fee_amount', { amount: formatCUP(cancellationFee.fee_cup) })}
          </Text>
          <Text variant="caption" className="text-amber-600 dark:text-amber-400 mt-0.5">
            {t('ride.cancel_fee_driver_compensated')}
          </Text>
        </View>
      )}

      {cancellationFee && cancellationFee.is_free && (
        <View className="rounded-xl px-4 py-3 mb-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700">
          <View className="flex-row items-center">
            <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
            <Text variant="bodySmall" className="ml-2 text-green-700 dark:text-green-300 font-medium">
              {t('ride.cancel_fee_free', { defaultValue: 'Cancelación gratuita' })}
            </Text>
          </View>
        </View>
      )}

      {/* Your penalty preview (progressive, based on cancellation count) */}
      <View
        className={`rounded-xl px-4 py-3 mb-4 ${
          hasPenalty
            ? 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700'
            : 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700'
        }`}
      >
        <Text
          variant="body"
          className={`font-semibold ${hasPenalty ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
        >
          {t('ride.cancel_your_penalty', { defaultValue: 'Tu penalización' })}:{' '}
          {hasPenalty ? formatCUP(penaltyAmount) : '0 CUP'}
        </Text>
        {!hasPenalty && (
          <Text variant="caption" className="text-green-600 dark:text-green-400 mt-0.5">
            {t('ride.cancel_free_label', { defaultValue: 'Primera cancelación del día' })}
          </Text>
        )}
      </View>

      {/* Reason selection */}
      <Text variant="bodySmall" color="secondary" className="mb-2">
        {t('ride.cancel_reason_title', { defaultValue: 'Razón (opcional)' })}
      </Text>
      <View className="flex-row flex-wrap gap-2 mb-6" accessibilityRole="radiogroup">
        {CANCEL_REASONS.map((reasonKey) => {
          const reasonText = t(`ride.${reasonKey}` as any, { defaultValue: reasonKey });
          return (
            <Pressable
              key={reasonKey}
              className={`px-3 py-2 rounded-full border ${
                selectedReason === reasonKey
                  ? 'bg-neutral-800 dark:bg-neutral-200 border-neutral-800 dark:border-neutral-200'
                  : 'bg-white dark:bg-neutral-800 border-neutral-300 dark:border-neutral-600'
              }`}
              onPress={() => {
                triggerSelection();
                setSelectedReason(selectedReason === reasonKey ? null : reasonKey);
              }}
              accessibilityRole="radio"
              accessibilityLabel={reasonText}
              accessibilityState={{ selected: selectedReason === reasonKey }}
            >
              <Text
                variant="caption"
                color={selectedReason === reasonKey ? 'inverse' : 'secondary'}
              >
                {reasonText}
              </Text>
            </Pressable>
          );
        })}
      </View>

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
        title={t('ride.cancel_go_back', { defaultValue: 'Volver' })}
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

/** Single policy rule row with bullet indicator */
function PolicyRow({ text, active }: { text: string; active: boolean }) {
  return (
    <View className="flex-row items-center mb-1">
      <View
        className={`w-2 h-2 rounded-full mr-2 ${
          active ? 'bg-primary-500' : 'bg-neutral-300'
        }`}
      />
      <Text
        variant="caption"
        color={active ? 'primary' : 'secondary'}
        className={active ? 'font-semibold' : ''}
      >
        {text}
      </Text>
    </View>
  );
}
