import React, { useState, useEffect } from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { incidentService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import type { IncidentReport } from '@tricigo/types';

const DRIVER_TIPS = ['tip_driver_1', 'tip_driver_2', 'tip_driver_3', 'tip_driver_4', 'tip_driver_5'] as const;

export default function DriverSafetyCenterScreen() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [tipsExpanded, setTipsExpanded] = useState(false);

  useEffect(() => {
    if (!user) return;
    incidentService.getMyIncidents(user.id).then(setIncidents).catch(() => {});
  }, [user]);

  const getReportTypeLabel = (type: string) => {
    const key = `safety.report_type_${type}` as const;
    return t(key, { defaultValue: type });
  };

  const getReportStatusLabel = (status: string) => {
    const key = `safety.report_status_${status}` as const;
    return t(key, { defaultValue: status });
  };

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4">
        <View className="flex-row items-center mb-6">
          <Pressable onPress={() => router.back()} className="mr-3">
            <Ionicons name="arrow-back" size={24} color={colors.neutral[800]} />
          </Pressable>
          <Text variant="h3" color="primary">{t('safety.title')}</Text>
        </View>

        <Text variant="bodySmall" color="primary" className="mb-4 opacity-60">
          {t('safety.desc')}
        </Text>

        {/* Emergency Services */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <View className="flex-row items-center mb-3">
            <View className="w-10 h-10 rounded-full bg-error items-center justify-center mr-3">
              <Ionicons name="warning" size={20} color="white" />
            </View>
            <View className="flex-1">
              <Text variant="body" color="primary" className="font-semibold">
                {t('safety.emergency_call')}
              </Text>
              <Text variant="caption" color="primary" className="opacity-50">
                {t('safety.emergency_call_desc')}
              </Text>
            </View>
          </View>
          <Button
            title={t('safety.emergency_call_button')}
            variant="danger"
            size="md"
            fullWidth
            onPress={() => Linking.openURL('tel:106')}
          />
        </Card>

        {/* Report Safety Issue */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/help')}
          >
            <View className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3">
              <Ionicons name="flag-outline" size={20} color={colors.neutral[400]} />
            </View>
            <View className="flex-1">
              <Text variant="body" color="primary" className="font-semibold">
                {t('safety.report')}
              </Text>
              <Text variant="caption" color="primary" className="opacity-50">
                {t('safety.report_desc')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.neutral[600]} />
          </Pressable>
        </Card>

        {/* Safety Tips for Drivers */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <Pressable
            className="flex-row items-center justify-between"
            onPress={() => setTipsExpanded(!tipsExpanded)}
          >
            <View className="flex-row items-center">
              <View className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3">
                <Ionicons name="bulb-outline" size={20} color={colors.neutral[400]} />
              </View>
              <Text variant="body" color="primary" className="font-semibold">
                {t('safety.tips_title')}
              </Text>
            </View>
            <Ionicons
              name={tipsExpanded ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={colors.neutral[500]}
            />
          </Pressable>
          {tipsExpanded && (
            <View className="mt-3 pt-3 border-t border-[#E2E8F0]">
              {DRIVER_TIPS.map((tipKey, idx) => (
                <View key={tipKey} className="flex-row items-start mb-2">
                  <Text variant="caption" color="primary" className="mr-2 opacity-50">
                    {idx + 1}.
                  </Text>
                  <Text variant="bodySmall" color="primary" className="flex-1">
                    {t(`safety.${tipKey}`)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Card>

        {/* My Safety Reports */}
        <Card theme="light" variant="filled" padding="md" className="mb-6 bg-white">
          <View className="flex-row items-center mb-3">
            <View className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3">
              <Ionicons name="document-text-outline" size={20} color={colors.neutral[400]} />
            </View>
            <Text variant="body" color="primary" className="font-semibold">
              {t('safety.my_reports')}
            </Text>
          </View>
          {incidents.length === 0 ? (
            <Text variant="caption" color="primary" className="text-center py-2 opacity-50">
              {t('safety.no_reports')}
            </Text>
          ) : (
            incidents.slice(0, 5).map((incident) => (
              <View key={incident.id} className="flex-row items-center justify-between py-2 border-t border-[#E2E8F0]">
                <View className="flex-1">
                  <Text variant="bodySmall" color="primary">{getReportTypeLabel(incident.type)}</Text>
                  <Text variant="caption" color="primary" className="opacity-50">
                    {new Date(incident.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <Text variant="caption" color={incident.status === 'resolved' ? 'accent' : 'secondary'}>
                  {getReportStatusLabel(incident.status)}
                </Text>
              </View>
            ))
          )}
        </Card>
      </View>
    </Screen>
  );
}
