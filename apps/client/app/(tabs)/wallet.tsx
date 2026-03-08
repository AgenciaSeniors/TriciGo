import React from 'react';
import { View } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';

export default function WalletScreen() {
  const { t } = useTranslation('common');

  return (
    <Screen bg="white" padded>
      <View className="pt-4">
        <Text variant="h3" className="mb-4">
          {t('wallet.title')}
        </Text>

        <BalanceBadge
          balance={0}
          held={0}
          size="lg"
          showHeld
          className="mb-6"
        />

        <View className="flex-row gap-3 mb-8">
          <Button
            title={t('wallet.recharge')}
            variant="primary"
            size="md"
            className="flex-1"
          />
          <Button
            title={t('wallet.transfer')}
            variant="outline"
            size="md"
            className="flex-1"
          />
        </View>

        <Text variant="h4" className="mb-3">
          {t('wallet.history')}
        </Text>
        <View className="items-center py-10">
          <Text variant="body" color="tertiary">
            {t('wallet.no_transactions')}
          </Text>
        </View>
      </View>
    </Screen>
  );
}
