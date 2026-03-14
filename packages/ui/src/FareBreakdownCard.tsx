import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatCUP, formatTRC } from '@tricigo/utils';
import { Text } from './Text';
import { Card } from './Card';

export interface FareBreakdownCardProps {
  /** Title text (e.g. "Fare breakdown") */
  title: string;
  /** Base fare in CUP */
  baseFareCup: number;
  /** Distance in meters */
  distanceM: number;
  /** Rate per km in CUP */
  perKmRateCup: number;
  /** Duration in seconds */
  durationS: number;
  /** Rate per minute in CUP */
  perMinRateCup: number;
  /** Surge multiplier (1.0 = no surge) */
  surgeMultiplier: number;
  /** Surge label (e.g. "Surge pricing 1.5x") — only shown if surge > 1 */
  surgeLabel?: string;
  /** Total fare in CUP */
  totalCup: number;
  /** Total fare in TRC centavos */
  totalTrc: number;
  /** Total label (e.g. "Estimated total") */
  totalLabel: string;
  /** Discount in TRC centavos */
  discountTrc?: number;
  /** Discount label */
  discountLabel?: string;
  /** Whether minimum fare was applied */
  minFareApplied?: boolean;
  /** Min fare note text */
  minFareNote?: string;
  /** Fare range min in TRC centavos */
  fareRangeMinTrc?: number;
  /** Fare range max in TRC centavos */
  fareRangeMaxTrc?: number;
  /** Fare range label (e.g. "Rango estimado") */
  fareRangeLabel?: string;
  /** Insurance premium in TRC centavos (shown if > 0) */
  insurancePremiumTrc?: number;
  /** Insurance label (e.g. "Seguro de viaje") */
  insuranceLabel?: string;
  /** Labels for breakdown rows */
  labels: {
    baseFare: string;
    distanceCharge: string;
    timeCharge: string;
    subtotal?: string;
  };
}

export function FareBreakdownCard({
  title,
  baseFareCup,
  distanceM,
  perKmRateCup,
  durationS,
  perMinRateCup,
  surgeMultiplier,
  surgeLabel,
  totalCup,
  totalTrc,
  totalLabel,
  discountTrc = 0,
  discountLabel,
  minFareApplied = false,
  minFareNote,
  fareRangeMinTrc,
  fareRangeMaxTrc,
  fareRangeLabel,
  insurancePremiumTrc = 0,
  insuranceLabel,
  labels,
}: FareBreakdownCardProps) {
  const distanceKm = distanceM / 1000;
  const durationMin = durationS / 60;
  const distanceCharge = Math.round(distanceKm * perKmRateCup);
  const timeCharge = Math.round(durationMin * perMinRateCup);
  const subtotal = baseFareCup + distanceCharge + timeCharge;
  const hasSurge = surgeMultiplier > 1;
  const finalTrc = totalTrc - discountTrc + insurancePremiumTrc;

  return (
    <Card variant="elevated" padding="lg">
      <Text variant="h4" className="mb-4">{title}</Text>

      {/* Base fare */}
      <Row label={labels.baseFare} value={formatCUP(baseFareCup)} />

      {/* Distance charge */}
      <Row
        label={labels.distanceCharge}
        value={formatCUP(distanceCharge)}
        detail={`${distanceKm.toFixed(1)} km × ${perKmRateCup} CUP/km`}
      />

      {/* Time charge */}
      <Row
        label={labels.timeCharge}
        value={formatCUP(timeCharge)}
        detail={`${Math.round(durationMin)} min × ${perMinRateCup} CUP/min`}
      />

      {/* Surge */}
      {hasSurge && (
        <>
          <View className="h-px bg-neutral-100 my-2" />
          <Row
            label={labels.subtotal ?? 'Subtotal'}
            value={formatCUP(subtotal)}
          />
          <View className="flex-row justify-between items-center mb-2">
            <View className="flex-row items-center">
              <Ionicons name="trending-up-outline" size={14} color="#f97316" />
              <Text variant="bodySmall" className="ml-1 text-orange-500">
                {surgeLabel ?? `×${surgeMultiplier}`}
              </Text>
            </View>
            <Text variant="bodySmall" className="text-orange-500">
              {formatCUP(Math.round(subtotal * surgeMultiplier))}
            </Text>
          </View>
        </>
      )}

      {/* Min fare note */}
      {minFareApplied && minFareNote && (
        <View className="flex-row items-center mb-2">
          <Ionicons name="information-circle-outline" size={14} color="#9ca3af" />
          <Text variant="caption" color="secondary" className="ml-1">
            {minFareNote}
          </Text>
        </View>
      )}

      {/* Discount */}
      {discountTrc > 0 && discountLabel && (
        <View className="flex-row justify-between mb-2">
          <Text variant="bodySmall" className="text-green-600">{discountLabel}</Text>
          <Text variant="bodySmall" className="text-green-600">-{formatTRC(discountTrc)}</Text>
        </View>
      )}

      {/* Insurance premium */}
      {insurancePremiumTrc > 0 && insuranceLabel && (
        <View className="flex-row justify-between items-center mb-2">
          <View className="flex-row items-center">
            <Ionicons name="shield-checkmark-outline" size={14} color="#3b82f6" />
            <Text variant="bodySmall" className="ml-1 text-blue-500">{insuranceLabel}</Text>
          </View>
          <Text variant="bodySmall" className="text-blue-500">+{formatTRC(insurancePremiumTrc)}</Text>
        </View>
      )}

      {/* Divider + Total */}
      <View className="h-px bg-neutral-200 my-3" />
      <View accessible accessibilityLabel={`${totalLabel}: ${formatTRC(finalTrc)}`} className="flex-row justify-between items-center">
        <Text variant="h4">{totalLabel}</Text>
        <Text variant="h3" color="accent">{formatTRC(finalTrc)}</Text>
      </View>

      {/* Fare range */}
      {fareRangeMinTrc != null && fareRangeMaxTrc != null && fareRangeMinTrc !== fareRangeMaxTrc && (
        <View className="flex-row items-center mt-2">
          <Ionicons name="swap-horizontal-outline" size={14} color="#9ca3af" />
          <Text variant="caption" color="secondary" className="ml-1">
            {fareRangeLabel ?? 'Rango estimado'}: {formatTRC(fareRangeMinTrc)} – {formatTRC(fareRangeMaxTrc)}
          </Text>
        </View>
      )}
    </Card>
  );
}

/** Helper row component */
function Row({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}${detail ? `, ${detail}` : ''}`}
      className="flex-row justify-between mb-2"
    >
      <View className="flex-1">
        <Text variant="bodySmall" color="secondary">{label}</Text>
        {detail && (
          <Text variant="caption" color="tertiary">{detail}</Text>
        )}
      </View>
      <Text variant="bodySmall">{value}</Text>
    </View>
  );
}
