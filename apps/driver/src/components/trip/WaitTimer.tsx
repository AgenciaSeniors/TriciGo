/**
 * WaitTimer — extracted from DriverTripView for PR-A.
 *
 * Renders the elapsed wait time once the driver has marked "arrived at
 * pickup". The first `freeMinutes` are shown as gratis; after that the
 * driver is "cobrando espera". Behavior unchanged from the inline
 * version: 1-second tick, guard against invalid `arrivedAt`.
 *
 * Visual + tokens are preserved verbatim — PR-A is structural only.
 * Migration to `midnightEmber` happens in PR-B.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';

interface WaitTimerProps {
  arrivedAt: string;
  freeMinutes: number;
}

export function WaitTimer({ arrivedAt, freeMinutes }: WaitTimerProps) {
  const { t } = useTranslation('driver');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const arrived = new Date(arrivedAt).getTime();
    if (isNaN(arrived)) return;
    const update = () => setElapsed(Math.floor((Date.now() - arrived) / 1000));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [arrivedAt]);

  // HF-3: Guard against invalid arrivedAt date
  const arrivedTime = new Date(arrivedAt).getTime();
  if (isNaN(arrivedTime)) return null;

  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = elapsed % 60;
  const isFree = elapsedMin < freeMinutes;
  const billableMin = Math.max(0, elapsedMin - freeMinutes);

  return (
    <View className={`rounded-2xl p-3 mb-3 items-center border border-white/[0.06] ${isFree ? 'bg-green-900/30' : 'bg-red-900/30'}`}>
      <Text variant="caption" color="inverse" className="opacity-60 mb-1">
        {t('trip.waiting_passenger', { defaultValue: 'Esperando al pasajero' })}
      </Text>
      <Text variant="h3" color="inverse" className="font-mono">
        {String(elapsedMin).padStart(2, '0')}:{String(elapsedSec).padStart(2, '0')}
      </Text>
      {isFree ? (
        <Text variant="caption" style={{ color: '#10B981' }} className="mt-1">
          {t('trip.wait_free', { defaultValue: 'Gratis' })} ({freeMinutes - elapsedMin} min)
        </Text>
      ) : (
        <Text variant="caption" style={{ color: '#EF4444' }} className="mt-1 font-semibold">
          {t('trip.wait_charging', { defaultValue: 'Cobrando espera' })} +{billableMin} min
        </Text>
      )}
    </View>
  );
}
