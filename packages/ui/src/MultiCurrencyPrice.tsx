import React from 'react';
import { View, Platform } from 'react-native';
import { formatTRC, formatCUP, formatUSD, trcToUsd } from '@tricigo/utils';
import { Text } from './Text';

export interface MultiCurrencyPriceProps {
  /** Amount in TRC/CUP whole units (1 TRC = 1 CUP) */
  amount: number;
  /** Exchange rate: 1 USD = X CUP/TRC (from eltoque) */
  exchangeRate: number;
  /** Display size */
  size?: 'sm' | 'md' | 'lg';
  /** Show USD equivalent */
  showUsd?: boolean;
  /** Layout: inline shows "500 TRC / $0.96" on one line, stacked shows them vertically */
  layout?: 'inline' | 'stacked';
  /** Color variant for the primary amount */
  color?: 'default' | 'accent' | 'inverse';
  /** Optional quota deduction amount to show below */
  deductionAmount?: number;
  /** Deduction label (e.g. "Cuota plataforma 15%") */
  deductionLabel?: string;
  /** Whether to use dark theme styling */
  forceDark?: boolean;
}

/**
 * Multi-currency price display component.
 * Shows TRC/CUP (same value since 1:1 peg) + USD equivalent.
 *
 * Examples:
 *   <MultiCurrencyPrice amount={500} exchangeRate={520} />
 *   → "500 TRC  ~$0.96 USD"
 *
 *   <MultiCurrencyPrice amount={500} exchangeRate={520} deductionAmount={75} deductionLabel="Cuota (15%)" />
 *   → "500 TRC  ~$0.96 USD"
 *   → "-75 TRC  Cuota (15%)"
 */
export function MultiCurrencyPrice({
  amount,
  exchangeRate,
  size = 'md',
  showUsd = true,
  layout = 'inline',
  color = 'default',
  deductionAmount,
  deductionLabel,
  forceDark = false,
}: MultiCurrencyPriceProps) {
  const usdAmount = trcToUsd(amount, exchangeRate);
  const isWeb = Platform.OS === 'web';

  // Size-based variants
  const primaryVariant = size === 'lg' ? 'h3' : size === 'sm' ? 'bodySmall' : 'body';
  const secondaryVariant = size === 'lg' ? 'body' : 'caption';

  // Color for primary
  const primaryColor = color === 'accent' ? 'accent' : color === 'inverse' ? 'inverse' : undefined;
  const secondaryColor = forceDark ? 'secondary' : 'tertiary';

  if (layout === 'stacked') {
    return (
      <View>
        {/* Primary: TRC amount */}
        <Text variant={primaryVariant} color={primaryColor} className="font-semibold">
          {formatTRC(amount)}
        </Text>

        {/* CUP equivalent (same value) */}
        <Text variant={secondaryVariant} color={secondaryColor}>
          = {formatCUP(amount)}
        </Text>

        {/* USD equivalent */}
        {showUsd && exchangeRate > 0 && (
          <Text variant={secondaryVariant} color={secondaryColor}>
            {'\u2248'} {formatUSD(usdAmount)}
          </Text>
        )}

        {/* Deduction row */}
        {deductionAmount != null && deductionAmount > 0 && (
          <View className="flex-row items-center mt-1">
            <Text variant={secondaryVariant} className="text-red-500 font-medium">
              -{formatTRC(deductionAmount)}
            </Text>
            {deductionLabel && (
              <Text variant="caption" color="secondary" className="ml-2">
                {deductionLabel}
              </Text>
            )}
          </View>
        )}
      </View>
    );
  }

  // Inline layout
  return (
    <View>
      <View
        className="flex-row items-baseline flex-wrap"
        style={isWeb ? { display: 'flex', flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 } : undefined}
      >
        {/* Primary: TRC amount */}
        <Text variant={primaryVariant} color={primaryColor} className="font-semibold">
          {formatTRC(amount)}
        </Text>

        {/* USD equivalent */}
        {showUsd && exchangeRate > 0 && (
          <Text variant={secondaryVariant} color={secondaryColor} className="ml-2">
            {'\u2248'} {formatUSD(usdAmount)}
          </Text>
        )}
      </View>

      {/* Deduction row */}
      {deductionAmount != null && deductionAmount > 0 && (
        <View
          className="flex-row items-center mt-1"
          style={isWeb ? { display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: 4 } : undefined}
        >
          <Text variant="caption" className="text-red-500 font-medium">
            -{formatTRC(deductionAmount)}
          </Text>
          {deductionLabel && (
            <Text variant="caption" color="secondary" className="ml-2">
              {deductionLabel}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
