import React, { useState, useEffect } from 'react';
import { View, Pressable, Linking, Alert, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark } from '@tricigo/theme';
import { incidentService, trustedContactService } from '@tricigo/api';
import { triggerHaptic, logger } from '@tricigo/utils';
import Toast from 'react-native-toast-message';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverRideStore } from '@/stores/ride.store';
import { useLocationStore } from '@/stores/location.store';
import type { IncidentReport } from '@tricigo/types';

const DRIVER_TIPS = ['tip_driver_1', 'tip_driver_2', 'tip_driver_3', 'tip_driver_4', 'tip_driver_5'] as const;

export default function DriverSafetyCenterScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const user = useAuthStore((s) => s.user);
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);
  const [incidents, setIncidents] = useState<IncidentReport[]>([]);
  const [tipsExpanded, setTipsExpanded] = useState(false);
  const [sosInFlight, setSosInFlight] = useState(false);

  useEffect(() => {
    if (!user) return;
    incidentService.getMyIncidents(user.id).then(setIncidents).catch(() => {});
  }, [user]);

  /**
   * SOS — full broadcast cascade equivalent al client RideActiveView.handleSOS
   * (PR #83). Tres acciones en paralelo, best-effort:
   *   1. createSOSReport       → registra el incidente en DB para soporte
   *   2. broadcastEmergency    → SMS automático a trusted contacts via edge
   *                              function `broadcast-emergency`
   *   3. tel:106               → línea cubana de emergencia (siempre se
   *                              ejecuta, incluso si las dos primeras fallan)
   *
   * Diferencia con el client: el driver puede activar SOS sin active trip
   * (rondando, idle, antes de aceptar viaje). En ese caso `activeTrip` es
   * null y el broadcast usa current driver location del location store.
   * Si SÍ hay active trip, incluye ride_id para que el SMS lo referencie.
   */
  const handleSOS = () => {
    if (!user || sosInFlight) return;
    triggerHaptic('heavy');
    Alert.alert(
      t('safety.sos_title', { defaultValue: 'SOS — Llamar a emergencias' }),
      t('safety.sos_body', {
        defaultValue: 'Vas a llamar al 106 y avisar a tus contactos de confianza por SMS. ¿Confirmas?',
      }),
      [
        { text: t('safety.sos_cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('safety.sos_call_emergency', { defaultValue: 'Llamar a emergencias' }),
          style: 'destructive',
          onPress: async () => {
            setSosInFlight(true);

            // (1) SOS report — silent failure
            if (activeTrip) {
              incidentService.createSOSReport({
                ride_id: activeTrip.id,
                reported_by: user.id,
                against_user_id: undefined, // El driver no dispara contra rider por defecto
                description: 'SOS activado por conductor durante viaje',
              }).catch((err) => {
                logger.error('SOS report failed (driver)', { error: String(err) });
              });
            } else {
              // No active trip — log a generic incident without ride context.
              // incidentService.createSOSReport requiere ride_id, así que en
              // su ausencia simplemente skip esta llamada y dejamos que el
              // broadcast SMS sea la evidencia.
              logger.info('SOS triggered without active trip — skipping createSOSReport', { user_id: user.id });
            }

            // (2) Trusted contacts broadcast — silent failure too. El SMS body
            //     dice "Un usuario de TriciGo envió SOS" sin distinguir rol —
            //     suficiente para que el contacto sepa que algo está mal.
            const lat = driverLat ?? 0;
            const lng = driverLng ?? 0;
            trustedContactService.broadcastEmergency({
              rideId: activeTrip?.id,
              latitude: lat,
              longitude: lng,
              riderName: user.full_name ?? null,
              // No pasamos driver_name/vehicle_plate porque el rol de quien
              // dispara es el driver — el SMS aplica al usuario que pidió ayuda.
            }).then((res) => {
              if (res.contacts_notified > 0) {
                Toast.show({
                  type: 'success',
                  text1: t('safety.sos_contacts_notified', {
                    count: res.contacts_notified,
                    defaultValue: `${res.contacts_notified} contactos avisados por SMS`,
                  }),
                });
              } else if (res.contacts_total === 0) {
                // No trusted contacts configured — sugerirle al driver
                Toast.show({
                  type: 'info',
                  text1: t('safety.sos_no_contacts', {
                    defaultValue: 'No tienes contactos de confianza configurados',
                  }),
                  text2: t('safety.sos_no_contacts_hint', {
                    defaultValue: 'Agregalos en Perfil → Contactos de confianza',
                  }),
                });
              }
            }).catch((err) => {
              logger.error('SOS broadcast failed (driver)', { error: String(err) });
              // No mostrar error toast — el driver está en emergencia
            }).finally(() => {
              setSosInFlight(false);
            });

            // (3) Línea de emergencia — siempre se abre (incluso si 1 y 2
            //     hicieron timeout). Llamar al final para que la confirmación
            //     del Alert no compita con el dialer del SO.
            Linking.openURL('tel:106');
          },
        },
      ],
    );
  };

  const getReportTypeLabel = (type: string) => {
    const key = `safety.report_type_${type}` as const;
    return t(key, { defaultValue: type });
  };

  const getReportStatusLabel = (status: string) => {
    const key = `safety.report_status_${status}` as const;
    return t(key, { defaultValue: status });
  };

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4">
        <ProfileScreenHeader
          title={t('safety.title')}
          onBack={() => router.back()}
        />

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
            title={sosInFlight
              ? t('safety.sos_processing', { defaultValue: 'Procesando…' })
              : t('safety.emergency_call_button')}
            variant="danger"
            size="md"
            fullWidth
            disabled={sosInFlight}
            onPress={handleSOS}
          />
        </Card>

        {/* Report Safety Issue */}
        <Card theme="light" variant="filled" padding="md" className="mb-3 bg-white">
          <Pressable
            className="flex-row items-center"
            onPress={() => router.push('/profile/help')}
          >
            <View className="w-10 h-10 rounded-full bg-neutral-100 items-center justify-center mr-3">
              <Ionicons name="flag-outline" size={20} color={midnightEmber.screen.text.tertiary} />
            </View>
            <View className="flex-1">
              <Text variant="body" color="primary" className="font-semibold">
                {t('safety.report')}
              </Text>
              <Text variant="caption" color="primary" className="opacity-50">
                {t('safety.report_desc')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={midnightEmber.screen.text.secondary} />
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
                <Ionicons name="bulb-outline" size={20} color={midnightEmber.screen.text.tertiary} />
              </View>
              <Text variant="body" color="primary" className="font-semibold">
                {t('safety.tips_title')}
              </Text>
            </View>
            <Ionicons
              name={tipsExpanded ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={midnightEmber.screen.text.tertiary}
            />
          </Pressable>
          {tipsExpanded && (
            <View className="mt-3 pt-3 border-t" style={{ borderTopColor: midnightEmber.screen.line.default }}>
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
              <Ionicons name="document-text-outline" size={20} color={midnightEmber.screen.text.tertiary} />
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
              <View key={incident.id} className="flex-row items-center justify-between py-2 border-t" style={{ borderTopColor: midnightEmber.screen.line.default }}>
                <View className="flex-1">
                  <Text variant="bodySmall" color="primary">{getReportTypeLabel(incident.type)}</Text>
                  <Text variant="caption" color="primary" className="opacity-50">
                    {new Date(incident.created_at).toLocaleDateString('es-CU', { timeZone: 'America/Havana' })}
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
      </View>
    </Screen>
  );
}
