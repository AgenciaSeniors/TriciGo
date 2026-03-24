import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { formatCUP } from '@tricigo/utils';
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
  /** Current ride status for emotional driver context */
  rideStatus?: string | null;
}

function CancelRideSheetInner({
  visible,
  onClose,
  onConfirm,
  penaltyAmount,
  cancelCount24h,
  isLoading,
  cancellationFee,
  rideStatus,
}: CancelRideSheetProps) {
  const { t } = useTranslation('rider');

  const hasFee = (cancellationFee && !cancellationFee.is_free) || penaltyAmount > 0;
  const feeAmount = cancellationFee?.fee_cup ?? penaltyAmount;

  const handleConfirm = () => {
    onConfirm('user_canceled');
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

      {/* Fee info */}
      {hasFee ? (
        <View className="rounded-xl px-4 py-3 mb-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700">
          <Text variant="body" className="font-semibold text-red-700 dark:text-red-300">
            {t('ride.cancel_fee_amount', { amount: formatCUP(feeAmount) })}
          </Text>
          <Text variant="caption" className="text-red-600 dark:text-red-400 mt-0.5">
            {t('ride.cancel_fee_driver_compensated')}
          </Text>
        </View>
      ) : (
        <View className="rounded-xl px-4 py-3 mb-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700">
          <View className="flex-row items-center">
            <Ionicons name="checkmark-circle" size={16} color={colors.success.DEFAULT} />
            <Text variant="body" className="ml-2 text-green-700 dark:text-green-300 font-medium">
              {t('ride.cancel_no_charge', { defaultValue: 'Sin cargo' })}
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
