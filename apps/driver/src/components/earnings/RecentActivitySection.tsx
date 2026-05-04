/**
 * RecentActivitySection — extracted from
 * apps/driver/app/(tabs)/earnings.tsx for PR-A.
 *
 * Collapsible card listing recent driver wallet transactions. The
 * section header is always visible; tap to expand. While expanded:
 *   - Shows up to 10 transactions per page.
 *   - "Ver más" footer triggers `onLoadMore()` while `hasMore` is true.
 *   - Empty state if `transactions.length === 0` and not loading.
 *
 * Owns the local `expanded` state (`txExpanded` in the original).
 * Notifies the parent of expansion via `onExpandedChange` so the
 * parent can trigger the initial fetch (mirrors the original
 * useEffect-on-`txExpanded` behaviour).
 *
 * Visual + tokens preserved verbatim from the inline version.
 * Migration to midnightEmber happens in PR-B.
 */
import React, { useState, useEffect } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { formatCUP } from '@tricigo/utils';
import { colors, driverStandardLightColors } from '@tricigo/theme';
import type { LedgerTransaction } from '@tricigo/types';

const lt = driverStandardLightColors;
const CARD_BG = lt.card;
const BORDER_SUBTLE = lt.border.default;
const CARD_SHADOW = {
  shadowColor: '#000',
  shadowOpacity: 0.04,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
};

export type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

interface RecentActivitySectionProps {
  transactions: TransactionWithAmount[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  /**
   * Notified when the user expands the section. Parent uses this to
   * trigger the initial fetch (preserving the original useEffect
   * gating on `txExpanded`).
   */
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
        style={{ backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER_SUBTLE, borderRadius: 16, ...CARD_SHADOW }}
      >
        <Pressable
          onPress={() => setExpanded((p) => !p)}
          className="flex-row items-center justify-between min-h-[48px]"
          accessibilityRole="button"
          accessibilityLabel={t('earnings.recent_activity', { defaultValue: 'Actividad reciente' })}
          accessibilityState={{ expanded }}
        >
          <View className="flex-row items-center">
            <Ionicons name="receipt-outline" size={18} color={colors.brand.orange} />
            <Text variant="body" className="ml-2 font-semibold" style={{ color: lt.text.primary }}>
              {t('earnings.recent_activity', { defaultValue: 'Actividad reciente' })}
            </Text>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={lt.text.secondary} />
        </Pressable>

        {expanded && (
          <View className="mt-3">
            {transactions.length === 0 && !loading && (
              <Text variant="bodySmall" style={{ color: lt.text.secondary }} className="text-center py-4">
                {t('earnings.no_transactions', { defaultValue: 'No hay transacciones recientes' })}
              </Text>
            )}
            {transactions.map((tx) => {
              const amount = tx.ledger_entries?.[0]?.amount ?? 0;
              const isCredit = amount > 0;
              const iconName = TX_ICONS[tx.type] ?? 'swap-horizontal';
              return (
                <View
                  key={tx.id}
                  className="flex-row items-center py-2"
                  style={{ borderBottomWidth: 1, borderBottomColor: BORDER_SUBTLE }}
                >
                  <Ionicons
                    name={iconName}
                    size={16}
                    color={isCredit ? colors.success.DEFAULT : '#EF4444'}
                  />
                  <View className="flex-1 ml-2">
                    <Text variant="bodySmall" style={{ color: lt.text.primary }}>
                      {t(`earnings.tx_${tx.type}`, { defaultValue: tx.type })}
                    </Text>
                    <Text variant="badge" style={{ color: lt.text.secondary }}>
                      {new Date(tx.created_at).toLocaleDateString()}
                    </Text>
                  </View>
                  <Text variant="bodySmall" style={{ color: isCredit ? colors.success.DEFAULT : '#EF4444', fontWeight: '600' }}>
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
                <Text variant="bodySmall" style={{ color: colors.brand.orange }}>
                  {loading ? '...' : t('earnings.view_more', { defaultValue: 'Ver mas' })}
                </Text>
              </Pressable>
            )}
            {loading && transactions.length === 0 && (
              <ActivityIndicator size="small" color={colors.brand.orange} className="py-4" />
            )}
          </View>
        )}
      </Card>
    </View>
  );
}
