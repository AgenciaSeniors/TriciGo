import React from 'react';
import { View, ScrollView } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { formatTRC } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useRouter } from 'expo-router';
import { useCorporateAccounts } from '@/hooks/useCorporateAccounts';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@tricigo/theme';

export default function CorporateProfileScreen() {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const { accounts, loading } = useCorporateAccounts();

  return (
    <Screen bg="white" padded scroll>
      <ScreenHeader
        title={t('corporate.title', { defaultValue: 'Cuenta Corporativa' })}
        onBack={() => router.back()}
      />

      {loading && (
        <Text variant="body" color="secondary" className="text-center mt-8">
          {t('common:loading', { defaultValue: 'Cargando...' })}
        </Text>
      )}

      {!loading && accounts.length === 0 && (
        <View className="items-center mt-12">
          <Ionicons name="business-outline" size={48} color={colors.neutral[300]} />
          <Text variant="body" color="secondary" className="mt-4 text-center">
            {t('corporate.no_membership')}
          </Text>
        </View>
      )}

      {accounts.map((acc) => (
        <Card key={acc.id} variant="outlined" padding="lg" className="mb-4 mt-4">
          <View className="flex-row items-center justify-between mb-3">
            <Text variant="h4">{acc.name}</Text>
            <StatusBadge status={acc.status} />
          </View>

          <View className="mb-3">
            <Text variant="caption" color="secondary">
              {t('corporate.contact', { defaultValue: 'Contacto' })}
            </Text>
            <Text variant="body">{acc.contact_phone}</Text>
            {acc.contact_email && (
              <Text variant="bodySmall" color="secondary">{acc.contact_email}</Text>
            )}
          </View>

          {acc.monthly_budget_trc > 0 && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.budget_remaining')}
              </Text>
              <View className="flex-row items-center mt-1">
                <View
                  className="h-2 rounded-full bg-primary-500"
                  style={{
                    width: `${Math.max(0, Math.min(100, ((acc.monthly_budget_trc - acc.current_month_spent) / acc.monthly_budget_trc) * 100))}%`,
                  }}
                />
                <View className="h-2 flex-1 rounded-full bg-neutral-200" />
              </View>
              <Text variant="caption" color="accent" className="mt-1">
                {formatTRC(acc.monthly_budget_trc - acc.current_month_spent)} / {formatTRC(acc.monthly_budget_trc)}
              </Text>
            </View>
          )}

          {acc.per_ride_cap_trc > 0 && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.per_ride_cap', { defaultValue: 'Máximo por viaje' })}
              </Text>
              <Text variant="body">{formatTRC(acc.per_ride_cap_trc)}</Text>
            </View>
          )}

          {acc.allowed_service_types.length > 0 && (
            <View className="mb-3">
              <Text variant="caption" color="secondary">
                {t('corporate.allowed_services', { defaultValue: 'Servicios permitidos' })}
              </Text>
              <Text variant="body">{acc.allowed_service_types.join(', ')}</Text>
            </View>
          )}

          {acc.allowed_hours_start && acc.allowed_hours_end && (
            <View>
              <Text variant="caption" color="secondary">
                {t('corporate.allowed_hours', { defaultValue: 'Horario permitido' })}
              </Text>
              <Text variant="body">{acc.allowed_hours_start} - {acc.allowed_hours_end}</Text>
            </View>
          )}
        </Card>
      ))}
    </Screen>
  );
}
