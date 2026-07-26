import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Linking, Share, useColorScheme, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { customerService, incidentService, rideService, trustedContactService } from '@tricigo/api';
import { useTokens } from '@/hooks/useTokens';
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
  const tokens = useTokens();
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };
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
    if (!user) { setLoading(false); return; }
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
      const url = `https://tricigo.com/track/share/${token}`;
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
    <Screen scroll bg="cuban" padded>
      <View className="pt-4">
        <ScreenHeader title={t('safety.title')} onBack={() => router.back()} />

        <Text variant="bodySmall" style={{ color: tokens.ink.secondary, marginTop: 8, marginBottom: 16 }}>
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
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 12, ...CARD_SHADOW }}>
          <View className="flex-row items-center mb-3">
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#EF4444', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="warning" size={20} color="#FFFFFF" />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('safety.emergency_call')}</Text>
              <Text variant="caption" style={{ color: tokens.ink.secondary }}>{t('safety.emergency_call_desc')}</Text>
            </View>
          </View>
          <Button
            title={t('safety.emergency_call_button')}
            variant="danger"
            size="md"
            fullWidth
            onPress={() => Linking.openURL('tel:106')}
          />
        </View>

        {/* Emergency contact — its own entry point.
            This used to be a read-only line inside the Trusted Contacts
            card: it reported "sin contacto de emergencia" while the only
            screen that can set one (profile/emergency-contact) had no
            navigation to it anywhere in the app, so the passenger was
            told about a gap they had no way to close. The web already
            links it from its safety page; this restores parity. */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 12, ...CARD_SHADOW }}>
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/emergency-contact')}
            accessibilityRole="button"
            accessibilityLabel={t('profile.emergency_contact_title')}
          >
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#EF44441A', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="medkit-outline" size={20} color="#EF4444" />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('profile.emergency_contact_title')}</Text>
              {emergencyContact ? (
                <Text variant="caption" style={{ color: tokens.ink.secondary }}>
                  {emergencyContact.name} — {emergencyContact.phone}
                </Text>
              ) : (
                <Text variant="caption" style={{ color: tokens.ink.secondary }}>{t('profile.no_emergency_contact')}</Text>
              )}
            </View>
            <Ionicons name="chevron-forward" size={20} color={tokens.ink.subtle} />
          </Pressable>
        </View>

        {/* Trusted Contacts */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 12, ...CARD_SHADOW }}>
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/trusted-contacts')}
            accessibilityRole="button"
            accessibilityLabel={t('trusted_contacts.title')}
          >
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#FF4D001A', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="people-outline" size={20} color="#FF4D00" />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('trusted_contacts.title')}</Text>
              {trustedCount > 0 && (
                <Text variant="caption" style={{ color: tokens.ink.secondary }}>
                  {t('safety.trusted_contacts_count', { count: trustedCount })}
                </Text>
              )}
            </View>
            <Ionicons name="chevron-forward" size={20} color={tokens.ink.subtle} />
          </Pressable>
        </View>

        {/* Share My Trip */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 12, ...CARD_SHADOW }}>
          <View className="flex-row items-center mb-2">
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#3B82F61A', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="share-outline" size={20} color="#3B82F6" />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('safety.share_trip')}</Text>
              <Text variant="caption" style={{ color: tokens.ink.secondary }}>{t('safety.share_trip_desc')}</Text>
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
            <Text variant="caption" style={{ color: tokens.ink.secondary, textAlign: 'center', paddingVertical: 4 }}>
              {t('safety.share_trip_inactive')}
            </Text>
          )}
        </View>

        {/* Report Safety Issue */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 12, ...CARD_SHADOW }}>
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/help')}
          >
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#F59E0B1A', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="flag-outline" size={20} color="#F59E0B" />
            </View>
            <View className="flex-1">
              <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('safety.report')}</Text>
              <Text variant="caption" style={{ color: tokens.ink.secondary }}>{t('safety.report_desc')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={tokens.ink.subtle} />
          </Pressable>
        </View>

        {/* Safety Tips */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 12, ...CARD_SHADOW }}>
          <Pressable
            className="flex-row items-center justify-between"
            onPress={() => setTipsExpanded(!tipsExpanded)}
          >
            <View className="flex-row items-center">
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#22C55E1A', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Ionicons name="bulb-outline" size={20} color="#22C55E" />
              </View>
              <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('safety.tips_title')}</Text>
            </View>
            <Ionicons
              name={tipsExpanded ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={tokens.ink.subtle}
            />
          </Pressable>
          {tipsExpanded && (
            <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.line }}>
              {SAFETY_TIPS.map((tipKey, idx) => (
                <View key={tipKey} className="flex-row items-start mb-2">
                  <Text variant="caption" style={{ color: tokens.ink.secondary, marginRight: 8 }}>{idx + 1}.</Text>
                  <Text variant="bodySmall" className="flex-1" style={{ color: tokens.ink.primary }}>{t(`safety.${tipKey}`)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* My Safety Reports */}
        <View style={{ backgroundColor: tokens.bg.elev1, borderRadius: 16, padding: 16, marginBottom: 24, ...CARD_SHADOW }}>
          <View className="flex-row items-center mb-3">
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: `${tokens.ink.secondary}1A`, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Ionicons name="document-text-outline" size={20} color={tokens.ink.secondary} />
            </View>
            <Text variant="body" className="font-semibold" style={{ color: tokens.ink.primary }}>{t('safety.my_reports')}</Text>
          </View>
          {incidents.length === 0 ? (
            <Text variant="caption" style={{ color: tokens.ink.secondary, textAlign: 'center', paddingVertical: 8 }}>
              {t('safety.no_reports')}
            </Text>
          ) : (
            incidents.slice(0, 5).map((incident) => (
              <View key={incident.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.line }}>
                <View className="flex-1">
                  <Text variant="bodySmall" style={{ color: tokens.ink.primary }}>{getReportTypeLabel(incident.type)}</Text>
                  <Text variant="caption" style={{ color: tokens.ink.secondary }}>
                    {new Date(incident.created_at).toLocaleDateString('es-CU', { timeZone: 'America/Havana' })}
                  </Text>
                </View>
                <Text variant="caption" color={incident.status === 'resolved' ? 'accent' : 'secondary'}>
                  {getReportStatusLabel(incident.status)}
                </Text>
              </View>
            ))
          )}
        </View>
        </>)}
      </View>
    </Screen>
  );
}
