import React, { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, Alert, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonListItem } from '@tricigo/ui/Skeleton';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { useTranslation } from '@tricigo/i18n';
import { deviceService, authService } from '@tricigo/api';
import { getErrorMessage, triggerHaptic } from '@tricigo/utils';
import type { KnownDevice } from '@tricigo/api';
import { ProfileSection } from '@/components/profile/ProfileSection';
import { useAuthStore } from '@/stores/auth.store';
import { useTokens } from '@/hooks/useTokens';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { getOrCreateDeviceId } from '@/lib/device';

/** Map a platform string to a sensible device icon. */
function platformIcon(platform: string | null): keyof typeof Ionicons.glyphMap {
  const p = (platform ?? '').toLowerCase();
  if (p.includes('ios')) return 'phone-portrait-outline';
  if (p.includes('android')) return 'phone-portrait-outline';
  if (p.includes('web')) return 'globe-outline';
  return 'hardware-chip-outline';
}

/** Readable "es" date for a device's last-seen ISO timestamp. */
function formatLastSeen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('es', {
      timeZone: 'America/Havana',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export default function DevicesScreen() {
  const { t } = useTranslation('common');
  const tokens = useTokens();
  const reset = useAuthStore((s) => s.reset);
  const [devices, setDevices] = useState<KnownDevice[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  const loadDevices = useCallback(() => {
    setLoading(true);
    setError(null);
    deviceService
      .listMyDevices()
      .then(setDevices)
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadDevices();
    // Resolve this install's device id so we can flag the matching row.
    getOrCreateDeviceId()
      .then(setCurrentDeviceId)
      .catch(() => {});
  }, [loadDevices]);

  // Stale-on-mount: refetch the device list on focus / app foreground (a device
  // revoked from another session / admin should drop off without a restart).
  useRefreshOnFocus(loadDevices);

  const handleRevoke = (device: KnownDevice) => {
    const title =
      [device.model, device.platform].filter(Boolean).join(' · ') ||
      t('devices.unknown', { defaultValue: 'Dispositivo desconocido' });
    triggerHaptic('warning');
    Alert.alert(
      t('devices.revoke_confirm_title', { defaultValue: '¿Quitar dispositivo?' }),
      t('devices.revoke_confirm_msg', {
        defaultValue:
          'Se quitará "{{device}}" de tus dispositivos conocidos. El próximo inicio de sesión desde ese dispositivo se tratará como nuevo.',
        device: title,
      }),
      [
        { text: t('cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('devices.revoke', { defaultValue: 'Quitar' }),
          style: 'destructive',
          onPress: async () => {
            try {
              await deviceService.revokeDevice(device.id);
              triggerHaptic('success');
              loadDevices();
            } catch (err) {
              Alert.alert(
                t('errors.generic_title', { defaultValue: 'Error' }),
                getErrorMessage(err),
              );
            }
          },
        },
      ],
    );
  };

  const handleSignOutAll = () => {
    triggerHaptic('warning');
    Alert.alert(
      t('devices.sign_out_all_confirm_title', { defaultValue: '¿Cerrar sesión en todos los dispositivos?' }),
      t('devices.sign_out_all_confirm_msg', {
        defaultValue:
          'Se cerrará tu sesión en todos los dispositivos, incluido este. Tendrás que iniciar sesión de nuevo.',
      }),
      [
        { text: t('cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('devices.sign_out_all', { defaultValue: 'Cerrar sesión en todos' }),
          style: 'destructive',
          onPress: async () => {
            setSigningOutAll(true);
            try {
              // Global scope: this is the one action where the user
              // explicitly asked to end sessions everywhere. The plain
              // `signOut()` is local-only by design.
              await authService.signOutAllDevices();
              // Auth guard handles redirect once the session is cleared.
              reset();
            } catch (err) {
              setSigningOutAll(false);
              Alert.alert(
                t('errors.generic_title', { defaultValue: 'Error' }),
                getErrorMessage(err),
              );
            }
          },
        },
      ],
    );
  };

  if (error) {
    return (
      <ErrorState
        title={t('errors.generic_title', { defaultValue: 'Error' })}
        description={error}
        onRetry={loadDevices}
      />
    );
  }

  return (
    <Screen scroll bg="cuban" padded>
      <View className="pt-4">
        <ScreenHeader
          title={t('devices.title', { defaultValue: 'Tus dispositivos' })}
          onBack={() => router.back()}
        />

        <View style={{ height: 12 }} />

        <Text variant="bodySmall" color="secondary" className="mb-4">
          {t('devices.subtitle', {
            defaultValue:
              'Estos son los dispositivos donde has iniciado sesión. Quita los que no reconozcas.',
          })}
        </Text>

        {loading ? (
          <View>
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        ) : devices.length === 0 ? (
          <EmptyState
            icon="phone-portrait-outline"
            title={t('devices.empty', { defaultValue: 'No hay dispositivos registrados todavía.' })}
          />
        ) : (
          <ProfileSection>
            {devices.map((device, idx) => {
              const title =
                [device.model, device.platform].filter(Boolean).join(' · ') ||
                t('devices.unknown', { defaultValue: 'Dispositivo desconocido' });
              const isCurrent = currentDeviceId !== null && device.device_id === currentDeviceId;
              const isLast = idx === devices.length - 1;
              return (
                <View
                  key={device.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 14,
                    paddingHorizontal: 14,
                    borderBottomWidth: isLast ? 0 : 1,
                    borderBottomColor: tokens.line,
                  }}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 11,
                      backgroundColor: `${tokens.accent.orange}1A`,
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: 14,
                    }}
                  >
                    <Ionicons name={platformIcon(device.platform)} size={18} color={tokens.accent.orange} />
                  </View>
                  <View style={{ flex: 1, marginRight: 12 }}>
                    <View className="flex-row items-center gap-2">
                      <Text numberOfLines={1} style={{ flexShrink: 1, color: tokens.ink.primary, fontSize: 15, fontWeight: '500' }}>
                        {title}
                      </Text>
                      {isCurrent && (
                        <StatusBadge
                          label={t('devices.this_device', { defaultValue: 'Este dispositivo' })}
                          variant="success"
                        />
                      )}
                    </View>
                    {device.os_version ? (
                      <Text style={{ color: tokens.ink.secondary, fontSize: 12, marginTop: 2 }}>
                        {t('devices.os', { defaultValue: 'Sistema' })}: {device.os_version}
                      </Text>
                    ) : null}
                    <Text style={{ color: tokens.ink.secondary, fontSize: 12, marginTop: 2 }}>
                      {t('devices.last_seen', {
                        defaultValue: 'Visto por última vez {{when}}',
                        when: formatLastSeen(device.last_seen_at),
                      })}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleRevoke(device)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('devices.revoke', { defaultValue: 'Quitar' })}
                  >
                    <Text style={{ color: '#EF4444', fontSize: 14, fontWeight: '600' }}>
                      {t('devices.revoke', { defaultValue: 'Quitar' })}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </ProfileSection>
        )}

        {/* Sign out everywhere — destructive secondary action. */}
        <Pressable
          onPress={handleSignOutAll}
          disabled={signingOutAll}
          accessibilityRole="button"
          accessibilityLabel={t('devices.sign_out_all', { defaultValue: 'Cerrar sesión en todos' })}
          style={({ pressed }) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: '#EF4444',
              backgroundColor: 'transparent',
              minHeight: 52,
              marginTop: 8,
              marginBottom: 24,
              opacity: signingOutAll ? 0.6 : 1,
            },
            pressed && { opacity: 0.8 },
          ]}
        >
          <Ionicons name="log-out-outline" size={20} color="#EF4444" />
          <Text style={{ color: '#EF4444', fontSize: 15, fontWeight: '600', marginLeft: 8 }}>
            {signingOutAll
              ? t('common.processing', { defaultValue: 'Procesando...' })
              : t('devices.sign_out_all_button', { defaultValue: 'Cerrar sesión en todos los dispositivos' })}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
