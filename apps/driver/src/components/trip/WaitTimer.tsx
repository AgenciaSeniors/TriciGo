/**
 * WaitTimer — Midnight Ember edition (PR-B).
 *
 * Renders the elapsed wait time once the driver has marked "arrived at
 * pickup". The first `freeMinutes` are shown as gratis; after that the
 * driver is "cobrando espera". 1-second tick, guard against invalid
 * `arrivedAt`.
 *
 * v2 tokenization:
 *   - Container bg follows `state.success` / `state.danger` family
 *     instead of raw `bg-green-900/30` / `bg-red-900/30` Tailwind
 *     literals.
 *   - Border consumes `midnightEmber.map.line.hairline`.
 *   - Free / charging text colors use `state.success` / `state.danger`
 *     directly so the semantic intent is explicit.
 *   - Numeric counter font uses `midnightEmber.text.dataLg` for the
 *     tabular monospace style consistent with the IncomingRideCard.
 */
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber } from '@tricigo/theme';

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

  // 12% alpha on the family color is enough to read as a tinted card on
  // the dark map surface without competing with the timer numbers.
  const containerBg = isFree
    ? `${midnightEmber.state.success}1F` // ~12%
    : `${midnightEmber.state.danger}1F`;

  return (
    <View
      style={{
        backgroundColor: containerBg,
        borderColor: midnightEmber.map.line.hairline,
        borderWidth: 1,
        borderRadius: midnightEmber.radius.card,
        padding: 12,
        marginBottom: 12,
        alignItems: 'center',
      }}
    >
      <Text variant="caption" color="inverse" className="opacity-60 mb-1">
        {t('trip.waiting_passenger', { defaultValue: 'Esperando' })}
      </Text>
      <Text
        style={{
          ...midnightEmber.text.dataLg,
          color: midnightEmber.map.text.primary,
        }}
      >
        {String(elapsedMin).padStart(2, '0')}:{String(elapsedSec).padStart(2, '0')}
      </Text>
      {isFree ? (
        <Text variant="caption" style={{ color: midnightEmber.state.success, marginTop: 4 }}>
          {t('trip.wait_free', { defaultValue: 'Gratis' })} ({freeMinutes - elapsedMin} min)
        </Text>
      ) : (
        <Text
          variant="caption"
          style={{
            color: midnightEmber.state.danger,
            marginTop: 4,
            fontWeight: '600',
          }}
        >
          {t('trip.wait_charging', { defaultValue: 'Cobrando' })} +{billableMin} min
        </Text>
      )}
    </View>
  );
}
