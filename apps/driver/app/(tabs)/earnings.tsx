import React from 'react';
import { View } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function EarningsScreen() {
  const { t } = useTranslation('driver');

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-4">
          {t('earnings.title')}
        </Text>

        <BalanceBadge
          balance={0}
          size="lg"
          className="mb-6"
        />

        {/* Stats */}
        <View className="flex-row gap-3 mb-6">
          <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
            <Text variant="caption" color="inverse" className="opacity-50">
              {t('earnings.today')}
            </Text>
            <Text variant="h4" color="inverse" className="mt-1">
              0 TC
            </Text>
          </Card>
          <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
            <Text variant="caption" color="inverse" className="opacity-50">
              {t('earnings.total_trips')}
            </Text>
            <Text variant="h4" color="inverse" className="mt-1">
              0
            </Text>
          </Card>
        </View>

        <Button
          title={t('earnings.redeem')}
          variant="outline"
          size="lg"
          fullWidth
          disabled
        />
      </View>
    </Screen>
  );
}
