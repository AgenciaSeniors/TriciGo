import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Linking, Share, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { customerService, incidentService, rideService, trustedContactService } from '@tricigo/api';
import { getErrorMessage, logger } from '@tricigo/utils';
import Toast from 'react-native-toast-message';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { IncidentReport } from '@tricigo/types';

const SAFETY_TIPS = ['tip_1', 'tip_2', 'tip_3', 'tip_4', 'tip_5'] as const;

export default function SafetyCenterScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const user = useAuthStore((s) => s.user);
  const activeRide = useRideStore((s) => s.activeRide);
  const [emergencyContact, setEmergencyContact] = useState<{ name: string; phone: string } | null>(null);
  const [trustedCount, setTrustedCount] = useState(0);
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [tipsExpanded, setTipsExpanded] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSafetyData = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    await Promise.allSettled([
      // Load emergency contact
      customerService.ensureProfile(user.id).then((cp) => {
        if (cp.emergency_contact) {
          setEmergencyContact({ name: cp.emergency_contact.name, phone: cp.emergency_contact.phone });
        }
      }).catch((err) => setError(getErrorMessage(err))),

      // Load trusted contacts count
      trustedContactService.getContacts(user.id).then((contacts) => {
        setTrustedCount(contacts.length);
        // Use emergency contact from trusted_contacts if available
        const emergency = contacts.find((c) => c.is_emergency);
        if (emergency) {
          setEmergencyContact({ name: emergency.name, phone: emergency.phone });
        }
      }).catch((err) => {
        logger.error('Error loading trusted contacts', { error: String(err) });
        Toast.show({ type: 'error', text1: t('errors.contacts_load_failed', { ns: 'common' }) });
      }),

      // Load incidents
      incidentService.getMyIncidents(user.id).then(setIncidents).catch((err) => {
        logger.error('Error loading incidents', { error: String(err) });
        Toast.show({ type: 'error', text1: t('errors.safety_load_failed', { ns: 'common' }) });
      }),
    ]);

    setLoading(false);
  }, [user]);

  useEffect(() => {
    loadSafetyData();
  }, [loadSafetyData]);

  const handleShareTrip = async () => {
    if (!activeRide) return;
    setSharing(true);
    try {
      let token = await rideService.getShareTokenForRide(activeRide.id);
      if (!token) {
        token = await rideService.generateShareToken(activeRide.id);
      }
      const url = `https://tricigo.app/track/share/${token}`;
      await Share.share({ message: t('safety.share_trip_message', { url }) });
    } catch {
      // dismissed
    } finally {
      setSharing(false);
    }
  };

  const getReportTypeLabel = (type: string) => {
    const key = `safety.report_type_${type}` as const;
    return t(key, { defaultValue: type });
  };

  const getReportStatusLabel = (status: string) => {
    const key = `safety.report_status_${status}` as const;
    return t(key, { defaultValue: status });
  };

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); loadSafetyData(); }} />;

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4">
        <ScreenHeader title={t('safety.title')} onBack={() => router.back()} />

        <Text variant="bodySmall" color="secondary" className="mb-4">
          {t('safety.desc')}
        </Text>

        {loading && (
          <View>
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        )}

        {!loading && (<>
        {/* Emergency Services */}
        <Card variant="outlined" padding="md" className="mb-3">
          <View className="flex-row items-center mb-3">
            <View className="w-10 h-10 rounded-full bg-error items-center justify-center mr-3">
              <Ionicons name="warning" size={20} color="white" />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold">{t('safety.emergency_call')}</Text>
              <Text variant="caption" color="secondary">{t('safety.emergency_call_desc')}</Text>
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

        {/* Trusted Contacts */}
        <Card variant="outlined" padding="md" className="mb-3">
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/trusted-contacts')}
          >
            <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
              <Ionicons name="people-outline" size={20} color={colors.primary[500]} />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold">{t('trusted_contacts.title')}</Text>
              {emergencyContact ? (
                <Text variant="caption" color="secondary">
                  {emergencyContact.name} — {emergencyContact.phone}
                </Text>
              ) : (
                <Text variant="caption" color="secondary">{t('profile.no_emergency_contact')}</Text>
              )}
              {trustedCount > 0 && (
                <Text variant="caption" color="secondary">
                  {t('safety.trusted_contacts_count', { count: trustedCount })}
                </Text>
              )}
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
          </Pressable>
        </Card>

        {/* Share My Trip */}
        <Card variant="outlined" padding="md" className="mb-3">
          <View className="flex-row items-center mb-2">
            <View className="w-10 h-10 rounded-full bg-primary-100 items-center justify-center mr-3">
              <Ionicons name="share-outline" size={20} color={colors.primary[500]} />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold">{t('safety.share_trip')}</Text>
              <Text variant="caption" color="secondary">{t('safety.share_trip_desc')}</Text>
            </View>
          </View>
          {activeRide ? (
            <Button
              title={sharing ? t('safety.share_trip_sharing') : t('safety.share_now')}
              variant="primary"
              size="md"
              fullWidth
              onPress={handleShareTrip}
              loading={sharing}
            />
          ) : (
            <Text variant="caption" color="secondary" className="text-center py-1">
              {t('safety.share_trip_inactive')}
            </Text>
          )}
        </Card>

        {/* Report Safety Issue */}
        <Card variant="outlined" padding="md" className="mb-3">
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/help')}
          >
            <View className="w-10 h-10 rounded-full bg-warning-100 items-center justify-center mr-3">
              <Ionicons name="flag-outline" size={20} color={isDark ? '#FBBF24' : (colors.warning?.DEFAULT ?? '#F59E0B')} />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold">{t('safety.report')}</Text>
              <Text variant="caption" color="secondary">{t('safety.report_desc')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
          </Pressable>
        </Card>

        {/* Safety Tips */}
        <Card variant="outlined" padding="md" className="mb-3">
          <Pressable
            className="flex-row items-center justify-between"
            onPress={() => setTipsExpanded(!tipsExpanded)}
          >
            <View className="flex-row items-center">
              <View className="w-10 h-10 rounded-full bg-success-100 items-center justify-center mr-3">
                <Ionicons name="bulb-outline" size={20} color={isDark ? '#4ADE80' : '#16A34A'} />
              </View>
              <Text variant="body" className="font-semibold">{t('safety.tips_title')}</Text>
            </View>
            <Ionicons
              name={tipsExpanded ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={colors.neutral[400]}
            />
          </Pressable>
          {tipsExpanded && (
            <View className="mt-3 pt-3 border-t border-neutral-100">
              {SAFETY_TIPS.map((tipKey, idx) => (
                <View key={tipKey} className="flex-row items-start mb-2">
                  <Text variant="caption" color="secondary" className="mr-2">{idx + 1}.</Text>
                  <Text variant="bodySmall" className="flex-1">{t(`safety.${tipKey}`)}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>

        {/* My Safety Reports */}
        <Card variant="outlined" padding="md" className="mb-6">
          <View className="flex-row items-center mb-3">
            <View className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3">
              <Ionicons name="document-text-outline" size={20} color={colors.neutral[500]} />
            </View>
            <Text variant="body" className="font-semibold">{t('safety.my_reports')}</Text>
          </View>
          {incidents.length === 0 ? (
            <Text variant="caption" color="secondary" className="text-center py-2">
              {t('safety.no_reports')}
            </Text>
          ) : (
            incidents.slice(0, 5).map((incident) => (
              <View key={incident.id} className="flex-row items-center justify-between py-2 border-t border-neutral-100">
                <View className="flex-1">
                  <Text variant="bodySmall">{getReportTypeLabel(incident.type)}</Text>
                  <Text variant="caption" color="secondary">
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
        </>)}
      </View>
    </Screen>
  );
}
