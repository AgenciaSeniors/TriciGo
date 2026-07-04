import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { Card } from '@tricigo/ui/Card';
import { triggerSelection } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { driverService } from '@tricigo/api';
import { midnightEmber } from '@tricigo/theme';

interface ExcessDistanceSheetProps {
  rideId: string;
  excessMeters: number;
  chargeableM: number;
  actualM: number;
  onComplete: () => void;
}

/**
 * BUG-222: Post-trip modal that asks the driver to justify a route that
 * exceeded 1.3× the estimated distance. The customer is NOT charged for
 * the excess kilometers — but the driver should explain why so admin can
 * review patterns of unjustified deviation.
 *
 * Predefined reasons cover the typical legitimate scenarios. "Other" lets
 * the driver type a free-form explanation.
 */
export function ExcessDistanceSheet({
  rideId,
  excessMeters,
  chargeableM,
  actualM,
  onComplete,
}: ExcessDistanceSheetProps) {
  const { t } = useTranslation('driver');
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reasons: { key: string; label: string }[] = [
    { key: 'extra_stop', label: t('excess.reason_extra_stop', { defaultValue: 'El cliente pidió una parada extra' }) },
    { key: 'street_blocked', label: t('excess.reason_street_blocked', { defaultValue: 'Calle bloqueada o desvío forzado' }) },
    { key: 'destination_changed', label: t('excess.reason_destination_changed', { defaultValue: 'El cliente cambió el destino verbalmente' }) },
    { key: 'traffic_long_detour', label: t('excess.reason_traffic_detour', { defaultValue: 'Tráfico requirió un desvío largo' }) },
    { key: 'other', label: t('excess.reason_other', { defaultValue: 'Otro motivo' }) },
  ];

  const handleSelectReason = (key: string) => {
    triggerSelection();
    setSelectedReason(key);
  };

  const handleSubmit = async () => {
    if (!selectedReason) return;
    const finalReason = selectedReason === 'other'
      ? `other: ${otherText.trim() || 'sin detalle'}`
      : selectedReason;
    setSubmitting(true);
    try {
      await driverService.setExcessDistanceReason(rideId, finalReason);
      Toast.show({
        type: 'success',
        text1: t('excess.thanks', { defaultValue: 'Gracias por la explicación' }),
      });
      onComplete();
    } catch (err) {
      console.warn('[ExcessDistanceSheet] failed', String(err));
      Toast.show({
        type: 'error',
        text1: t('excess.failed', { defaultValue: 'No se pudo guardar el motivo' }),
      });
      setSubmitting(false);
    }
  };

  const excessKm = (excessMeters / 1000).toFixed(2);
  const chargeableKm = (chargeableM / 1000).toFixed(2);
  const actualKm = (actualM / 1000).toFixed(2);

  return (
    <View className="flex-1 px-5 py-6">
      <Card theme="dark" variant="filled" padding="lg" className="mb-4">
        <Text variant="h3" color="inverse" className="mb-2">
          {t('excess.title', { defaultValue: 'Tu ruta fue más larga de lo estimado' })}
        </Text>
        <Text variant="body" color="secondary" style={{ color: midnightEmber.map.text.secondary }} className="mb-3">
          {t('excess.summary', {
            defaultValue: 'Recorriste {{actual}} km, pero al cliente solo se le cobraron {{chargeable}} km (la diferencia de {{excess}} km no se cobra).',
            actual: actualKm,
            chargeable: chargeableKm,
            excess: excessKm,
          })}
        </Text>
        <Text variant="caption" color="tertiary">
          {t('excess.why_we_ask', {
            defaultValue: 'Para que podamos cubrirte la próxima vez, contanos qué pasó.',
          })}
        </Text>
      </Card>

      <View className="mb-4">
        {reasons.map((r) => {
          const isSelected = selectedReason === r.key;
          return (
            <Pressable
              key={r.key}
              onPress={() => handleSelectReason(r.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              className="flex-row items-center px-4 py-3 mb-2 rounded-2xl"
              style={{
                backgroundColor: isSelected ? midnightEmber.accent.glow : midnightEmber.map.bg.surface,
                borderWidth: isSelected ? 2 : 1,
                borderColor: isSelected ? midnightEmber.accent[500] : midnightEmber.map.line.default,
              }}
            >
              <View className={`w-5 h-5 rounded-full mr-3 ${isSelected ? 'bg-orange-500' : 'border-2 border-neutral-300'}`}>
                {isSelected && <View className="w-2 h-2 rounded-full bg-white m-auto mt-[6px]" />}
              </View>
              <Text
                variant="body"
                color="primary"
                style={{ color: midnightEmber.map.text.primary }}
                className="flex-1"
              >
                {r.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {selectedReason === 'other' && (
        <View className="mb-4">
          <Input
            placeholder={t('excess.other_placeholder', { defaultValue: 'Describí brevemente qué pasó…' })}
            value={otherText}
            onChangeText={setOtherText}
            multiline
            numberOfLines={3}
            variant="dark"
          />
        </View>
      )}

      <Button
        title={submitting
          ? t('excess.submitting', { defaultValue: 'Guardando…' })
          : t('excess.submit', { defaultValue: 'Enviar' })}
        onPress={handleSubmit}
        disabled={!selectedReason || submitting}
        loading={submitting}
        fullWidth
        size="lg"
      />
      <Pressable onPress={onComplete} className="mt-3 items-center py-2">
        <Text variant="caption" color="tertiary">
          {t('excess.skip', { defaultValue: 'Saltar por ahora' })}
        </Text>
      </Pressable>
    </View>
  );
}
