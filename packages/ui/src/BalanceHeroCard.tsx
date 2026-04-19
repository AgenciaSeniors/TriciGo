/**
 * BalanceHeroCard — prominent TriciCoin balance display.
 *
 * First thing the user sees on home. Shows TC amount + USD equivalent
 * at the current exchange rate, with a subtle orange radial glow on
 * the right side for depth (no material elevation — respects the flat
 * "cuban modern" aesthetic).
 *
 * Reference: docs/DESIGN_CLIENT_HOME.md §4
 */
import React from 'react';
import { View, Text as RNText, StyleSheet, Pressable } from 'react-native';
import { cubanLight, cubanDark } from '@tricigo/theme';

export interface BalanceHeroCardProps {
  /** Balance in TriciCoin (= CUP internally, 1 TC = 1 CUP). */
  balanceTc: number;
  /** USD equivalent at current exchange rate. */
  balanceUsd: number;
  mode?: 'light' | 'dark';
  onPress?: () => void;
  label?: string;
}

function formatTc(n: number): string {
  return n.toLocaleString('es-CU', { maximumFractionDigits: 0 });
}

function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BalanceHeroCard({
  balanceTc,
  balanceUsd,
  mode = 'light',
  onPress,
  label = 'Saldo disponible',
}: BalanceHeroCardProps) {
  const tokens = mode === 'dark' ? cubanDark : cubanLight;

  const inner = (
    <View
      style={[
        styles.card,
        {
          backgroundColor: tokens.bg.elev1,
          borderColor: tokens.line,
        },
      ]}
    >
      {/* Radial glow on the right */}
      <View
        style={[
          styles.glow,
          { backgroundColor: tokens.accent.orangeGlow },
        ]}
      />

      <View style={styles.labelRow}>
        <View style={[styles.labelDiamond, { backgroundColor: tokens.accent.orange }]} />
        <RNText style={[styles.label, { color: tokens.ink.subtle }]}>
          {label.toUpperCase()}
        </RNText>
      </View>

      <View style={styles.row}>
        <View style={styles.amountRow}>
          <RNText style={[styles.amount, { color: tokens.ink.primary }]}>
            {formatTc(balanceTc)}
          </RNText>
          <RNText style={[styles.unit, { color: tokens.ink.secondary }]}>TC</RNText>
        </View>
        <RNText style={[styles.usd, { color: tokens.accent.warm }]}>
          ↗ {formatUsd(balanceUsd)} USD
        </RNText>
      </View>
    </View>
  );

  if (onPress) {
    return <Pressable onPress={onPress}>{inner}</Pressable>;
  }
  return inner;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    overflow: 'hidden',
    position: 'relative',
  },
  glow: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 140,
    height: '100%',
    opacity: 0.6,
    borderBottomRightRadius: 24,
    borderTopRightRadius: 24,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  labelDiamond: {
    width: 6,
    height: 6,
    transform: [{ rotate: '45deg' }],
  },
  label: {
    fontFamily: 'JetBrainsMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 8,
    gap: 12,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  amount: {
    fontFamily: 'BricolageGrotesque_700Bold',
    fontSize: 32,
    letterSpacing: -1.2,
  },
  unit: {
    fontFamily: 'BricolageGrotesque_500Medium',
    fontSize: 14,
    marginLeft: 4,
  },
  usd: {
    fontFamily: 'JetBrainsMono_500Medium',
    fontSize: 13,
  },
});
