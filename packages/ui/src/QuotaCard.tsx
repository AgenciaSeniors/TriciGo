import React from 'react';
import { View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatTRC, formatUSD, trcToUsd } from '@tricigo/utils';
import { Text } from './Text';
import { Card } from './Card';
import { Button } from './Button';

export interface QuotaCardProps {
  /** Current quota balance in TRC (= CUP) */
  balance: number;
  /** Total ever recharged (for progress bar) */
  totalRecharged: number;
  /** Exchange rate for USD display */
  exchangeRate: number;
  /** Deduction rate as fraction (e.g. 0.15 = 15%) */
  deductionRate: number;
  /** Whether the low-quota warning is active */
  warningActive: boolean;
  /** Remaining grace trips */
  graceTripsRemaining: number;
  /** Whether driver is blocked */
  blocked: boolean;
  /** Callback for recharge button */
  onRecharge?: () => void;
  /** Labels */
  labels: {
    title: string;
    balance: string;
    recharge: string;
    lowWarning: string;
    graceMessage: string;
    blockedMessage: string;
    deductionInfo: string;
  };
}

/**
 * Driver quota display card.
 * Shows remaining quota balance with progress bar, warnings, and recharge CTA.
 */
export function QuotaCard({
  balance,
  totalRecharged,
  exchangeRate,
  deductionRate,
  warningActive,
  graceTripsRemaining,
  blocked,
  onRecharge,
  labels,
}: QuotaCardProps) {
  const progress = totalRecharged > 0 ? Math.max(0, Math.min(1, balance / totalRecharged)) : 0;
  const usdBalance = trcToUsd(balance, exchangeRate);
  const pctLabel = `${Math.round(deductionRate * 100)}%`;
  const isWeb = Platform.OS === 'web';

  // Color based on status
  const barColor = blocked
    ? '#ef4444'
    : warningActive
      ? '#f59e0b'
      : '#22c55e';

  const statusIcon = blocked
    ? 'close-circle'
    : warningActive
      ? 'warning'
      : 'checkmark-circle';

  const statusColor = blocked
    ? '#ef4444'
    : warningActive
      ? '#f59e0b'
      : '#22c55e';

  return (
    <Card forceDark variant="filled" padding="lg" className="bg-neutral-800">
      {/* Header */}
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center">
          <Ionicons name="wallet-outline" size={20} color="#f97316" />
          <Text variant="h4" color="inverse" className="ml-2">{labels.title}</Text>
        </View>
        <Ionicons name={statusIcon as any} size={20} color={statusColor} />
      </View>

      {/* Balance */}
      <Text variant="stat" color="accent" className="mb-1">
        {formatTRC(Math.max(balance, 0))}
      </Text>
      <Text variant="caption" color="secondary" className="mb-4">
        {'\u2248'} {formatUSD(usdBalance)}
      </Text>

      {/* Progress bar */}
      <View
        className="h-2 rounded-full bg-neutral-700 mb-2 overflow-hidden"
        style={isWeb ? { height: 8, borderRadius: 4, backgroundColor: '#404040', marginBottom: 8, overflow: 'hidden' } : undefined}
      >
        <View
          className="h-full rounded-full"
          style={[
            { width: `${Math.round(progress * 100)}%`, backgroundColor: barColor },
            isWeb && { height: '100%', borderRadius: 4 },
          ] as any}
        />
      </View>

      {/* Deduction info */}
      <Text variant="caption" color="secondary" className="mb-3">
        {labels.deductionInfo.replace('{pct}', pctLabel)}
      </Text>

      {/* Warning / Grace / Blocked messages */}
      {blocked && (
        <View className="flex-row items-center bg-red-900/30 rounded-xl px-3 py-2 mb-3">
          <Ionicons name="close-circle" size={16} color="#ef4444" />
          <Text variant="bodySmall" className="text-red-400 ml-2 flex-1">
            {labels.blockedMessage}
          </Text>
        </View>
      )}

      {!blocked && graceTripsRemaining > 0 && balance <= 0 && (
        <View className="flex-row items-center bg-amber-900/30 rounded-xl px-3 py-2 mb-3">
          <Ionicons name="warning" size={16} color="#f59e0b" />
          <Text variant="bodySmall" className="text-amber-400 ml-2 flex-1">
            {labels.graceMessage.replace('{count}', String(graceTripsRemaining))}
          </Text>
        </View>
      )}

      {!blocked && warningActive && balance > 0 && (
        <View className="flex-row items-center bg-amber-900/30 rounded-xl px-3 py-2 mb-3">
          <Ionicons name="warning" size={16} color="#f59e0b" />
          <Text variant="bodySmall" className="text-amber-400 ml-2 flex-1">
            {labels.lowWarning}
          </Text>
        </View>
      )}

      {/* Recharge button */}
      {onRecharge && (
        <Button
          title={labels.recharge}
          onPress={onRecharge}
          size="md"
          fullWidth
          className="mt-2"
        />
      )}
    </Card>
  );
}
