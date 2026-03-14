import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Card } from '@tricigo/ui/Card';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

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
}

const CANCEL_REASONS = [
  'cancel_reason_changed_mind',
  'cancel_reason_driver_late',
  'cancel_reason_mistake',
  'cancel_reason_other',
] as const;

export function CancelRideSheet({
  visible,
  onClose,
  onConfirm,
  penaltyAmount,
  cancelCount24h,
  isLoading,
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

      {/* Your penalty preview */}
      <View
        className={`rounded-xl px-4 py-3 mb-4 ${
          hasPenalty ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'
        }`}
      >
        <Text
          variant="body"
          className={`font-semibold ${hasPenalty ? 'text-red-700' : 'text-green-700'}`}
        >
          {t('ride.cancel_your_penalty', { defaultValue: 'Tu penalización' })}:{' '}
          {hasPenalty ? formatCUP(penaltyAmount) : '0 CUP'}
        </Text>
        {!hasPenalty && (
          <Text variant="caption" className="text-green-600 mt-0.5">
            {t('ride.cancel_free_label', { defaultValue: 'Primera cancelación del día' })}
          </Text>
        )}
      </View>

      {/* Reason selection */}
      <Text variant="bodySmall" color="secondary" className="mb-2">
        {t('ride.cancel_reason_title', { defaultValue: 'Razón (opcional)' })}
      </Text>
      <View className="flex-row flex-wrap gap-2 mb-6">
        {CANCEL_REASONS.map((reasonKey) => (
          <Pressable
            key={reasonKey}
            className={`px-3 py-2 rounded-full border ${
              selectedReason === reasonKey
                ? 'bg-neutral-800 border-neutral-800'
                : 'bg-white border-neutral-300'
            }`}
            onPress={() =>
              setSelectedReason(selectedReason === reasonKey ? null : reasonKey)
            }
          >
            <Text
              variant="caption"
              color={selectedReason === reasonKey ? 'inverse' : 'secondary'}
            >
              {t(`ride.${reasonKey}` as any, { defaultValue: reasonKey })}
            </Text>
          </Pressable>
        ))}
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
