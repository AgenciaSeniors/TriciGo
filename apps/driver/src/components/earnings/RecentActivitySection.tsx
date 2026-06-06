/**
 * RecentActivitySection — Midnight Ember edition (PR-B).
 *
 * Collapsible card listing recent driver wallet transactions.
 *
 * v2 tokenization:
 *   - Card surface: `screen.bg.surface` + `line.default` + `radius.card`
 *     + `shadow.card`.
 *   - Tx list separator: `screen.line.hairline`.
 *   - Header icon + "Ver mas" link: `accent[500]`.
 *   - Tx amount + icon: `state.success` (credit) / `state.danger`
 *     (debit). The single source of truth replaces three independent
 *     hex literals (`#22C55E` and `#EF4444` repeated).
 *   - Header chevron + secondary labels via `screen.text.*`.
 */
import React, { useState, useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP, signedLedgerAmountForAccount } from '@tricigo/utils';
import { midnightEmber } from '@tricigo/theme';
import type { LedgerTransaction } from '@tricigo/types';

export type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

interface RecentActivitySectionProps {
  transactions: TransactionWithAmount[];
  /** Driver's wallet account id — sum entries for THIS account (a mixed-ride
   *  txn credits the wallet portion AND debits commission; reading entry[0]
   *  would show the gross wallet portion instead of the net). */
  accountId?: string | null;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onExpandedChange?: (expanded: boolean) => void;
}

const TX_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  recharge: 'add-circle',
  ride_payment: 'car',
  commission: 'cut',
  transfer_in: 'arrow-down-circle',
  transfer_out: 'arrow-up-circle',
  promo_credit: 'gift',
  redemption: 'wallet',
};

export function RecentActivitySection({
  transactions,
  accountId,
  loading,
  hasMore,
  onLoadMore,
  onExpandedChange,
}: RecentActivitySectionProps) {
  const { t } = useTranslation('driver');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  return (
    <View className="mt-8 mb-4">
      <Card
        variant="filled"
        padding="md"
        style={{
          backgroundColor: midnightEmber.screen.bg.surface,
          borderWidth: 1,
          borderColor: midnightEmber.screen.line.default,
          borderRadius: midnightEmber.radius.card,
          ...midnightEmber.shadow.card,
        }}
      >
        <Pressable
          onPress={() => setExpanded((p) => !p)}
          className="flex-row items-center justify-between min-h-[48px]"
          accessibilityRole="button"
          accessibilityLabel={t('earnings.recent_activity', { defaultValue: 'Movimientos' })}
          accessibilityState={{ expanded }}
        >
          <View className="flex-row items-center">
            <Ionicons
              name="receipt-outline"
              size={18}
              color={midnightEmber.accent[500]}
            />
            <Text
              variant="body"
              className="font-semibold"
              style={{ color: midnightEmber.screen.text.primary, marginLeft: 8 }}
            >
              {t('earnings.recent_activity', { defaultValue: 'Movimientos' })}
            </Text>
          </View>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={midnightEmber.screen.text.secondary}
          />
        </Pressable>

        {expanded && (
          <View className="mt-3">
            {transactions.length === 0 && !loading && (
              <Text
                variant="bodySmall"
                className="text-center py-4"
                style={{ color: midnightEmber.screen.text.secondary }}
              >
                {t('earnings.no_transactions', { defaultValue: 'No hay transacciones recientes' })}
              </Text>
            )}
            {transactions.map((tx) => {
              const amount = signedLedgerAmountForAccount(tx.ledger_entries, accountId);
              const isCredit = amount > 0;
              const txColor = isCredit
                ? midnightEmber.state.success
                : midnightEmber.state.danger;
              const iconName = TX_ICONS[tx.type] ?? 'swap-horizontal';
              return (
                <View
                  key={tx.id}
                  className="flex-row items-center py-2"
                  style={{
                    borderBottomWidth: 1,
                    borderBottomColor: midnightEmber.screen.line.hairline,
                  }}
                >
                  <Ionicons name={iconName} size={16} color={txColor} />
                  <View className="flex-1 ml-2">
                    <Text
                      variant="bodySmall"
                      style={{ color: midnightEmber.screen.text.primary }}
                    >
                      {t(`earnings.tx_${tx.type}`, { defaultValue: tx.type })}
                    </Text>
                    <Text
                      variant="badge"
                      style={{ color: midnightEmber.screen.text.secondary }}
                    >
                      {new Date(tx.created_at).toLocaleDateString()}
                    </Text>
                  </View>
                  <Text
                    variant="bodySmall"
                    style={{ color: txColor, fontWeight: '600' }}
                  >
                    {isCredit ? '+' : ''}{formatCUP(amount)}
                  </Text>
                </View>
              );
            })}
            {hasMore && transactions.length > 0 && (
              <Pressable
                onPress={onLoadMore}
                className="py-3 items-center min-h-[48px] justify-center"
                accessibilityRole="button"
                accessibilityLabel={t('earnings.view_more', { defaultValue: 'Ver mas' })}
              >
                <Text
                  variant="bodySmall"
                  style={{ color: midnightEmber.accent[500] }}
                >
                  {loading ? '...' : t('earnings.view_more', { defaultValue: 'Ver mas' })}
                </Text>
              </Pressable>
            )}
            {loading && transactions.length === 0 && (
              <ActivityIndicator
                size="small"
                color={midnightEmber.accent[500]}
                className="py-4"
              />
            )}
          </View>
        )}
      </Card>
    </View>
  );
}
