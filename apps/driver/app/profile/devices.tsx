/**
 * DriverDevicesScreen — "Tus dispositivos".
 *
 * Lists the logged-in user's known login devices (user_known_devices,
 * surfaced by deviceService.listMyDevices), lets them remove any device,
 * and exposes a "Cerrar sesión en todos los dispositivos" action that
 * signs out + revokes every session via authService.signOut.
 *
 * Conventions mirror the rest of apps/driver/app/profile/*:
 *   - Screen + ProfileScreenHeader scaffold (see settings.tsx).
 *   - cubanLight/cubanDark palette + midnightEmber surfaces/lines.
 *   - Destructive actions go through Alert.alert confirmation.
 *   - i18n via t('key', { defaultValue: '…' }) with Spanish defaults
 *     (post-2026-04 convention — no JSON entries until a real
 *     translation diverges from the fallback).
 *   - Sign-out resets the same zustand stores as the profile tab's
 *     doLogout (auth + driver + notifications) so state never leaks
 *     across accounts.
 *
 * The current device (matched by getOrCreateDeviceId() against each
 * row's device_id) is tagged "Este dispositivo" and cannot be removed —
 * use the all-sessions sign-out for that instead.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Pressable, Alert, ActivityIndicator, useColorScheme } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { midnightEmber, cubanLight, cubanDark, colors } from '@tricigo/theme';
import { deviceService, authService } from '@tricigo/api';
import type { KnownDevice } from '@tricigo/api';
import { getOrCreateDeviceId } from '@/lib/device';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useNotificationStore } from '@/stores/notification.store';

const PLATFORM_LABELS: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
  web: 'Web',
};

export default function DriverDevicesScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const reset = useAuthStore((s) => s.reset);
  const resetDriver = useDriverStore((s) => s.reset);
  const resetNotifications = useNotificationStore((s) => s.reset);

  const [devices, setDevices] = useState<KnownDevice[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const [rows, deviceId] = await Promise.all([
        deviceService.listMyDevices(),
        getOrCreateDeviceId(),
      ]);
      setDevices(rows);
      setCurrentDeviceId(deviceId);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const formatLastSeen = (iso: string): string => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('es-CU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const deviceTitle = (device: KnownDevice): string => {
    const platformLabel = device.platform ? PLATFORM_LABELS[device.platform] ?? device.platform : null;
    const title = [device.model, platformLabel].filter(Boolean).join(' · ');
    return title || t('devices.unknown', { defaultValue: 'Dispositivo desconocido' });
  };

  const handleRemove = (device: KnownDevice) => {
    Alert.alert(
      t('devices.revoke_confirm_title', { defaultValue: 'Quitar dispositivo' }),
      t('devices.revoke_confirm_msg', {
        defaultValue: 'Se quitará este dispositivo de tu lista. El próximo inicio de sesión desde él se tratará como nuevo.',
      }),
      [
        { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('devices.revoke', { defaultValue: 'Quitar' }),
          style: 'destructive',
          onPress: async () => {
            try {
              await deviceService.revokeDevice(device.id);
              await load();
            } catch {
              Alert.alert('Error', t('devices.revoke_error', { defaultValue: 'No se pudo quitar el dispositivo.' }));
            }
          },
        },
      ],
    );
  };

  const doSignOutAll = async () => {
    setSigningOut(true);
    try {
      // Global scope: this is the one action where the user explicitly
      // asked to end sessions everywhere. The plain `signOut()` is
      // local-only by design.
      await authService.signOutAllDevices();
      reset();
      resetDriver();
      resetNotifications();
      router.replace('/(auth)/login');
    } catch {
      // Mirror profile.tsx doLogout: clear local state even if the remote
      // sign-out request fails, so the session never lingers on device.
      reset();
      resetDriver();
      resetNotifications();
      router.replace('/(auth)/login');
    } finally {
      setSigningOut(false);
    }
  };

  const handleSignOutAll = () => {
    Alert.alert(
      t('devices.sign_out_all_confirm_title', { defaultValue: 'Cerrar sesión en todos los dispositivos' }),
      t('devices.sign_out_all_confirm_msg', {
        defaultValue: 'Se cerrará tu sesión en este y todos los demás dispositivos. Tendrás que iniciar sesión de nuevo.',
      }),
      [
        { text: t('common.cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
        {
          text: t('devices.sign_out_all', { defaultValue: 'Cerrar sesión en todos' }),
          style: 'destructive',
          onPress: doSignOutAll,
        },
      ],
    );
  };

  return (
    <Screen scroll bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'} padded>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
        <View className="pt-4 pb-12">
          <ProfileScreenHeader
            title={t('devices.title', { defaultValue: 'Tus dispositivos' })}
            onBack={() => router.back()}
            backAccessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
          />

          <Text variant="bodySmall" color="secondary" className="mb-4">
            {t('devices.subtitle', {
              defaultValue: 'Estos son los dispositivos donde has iniciado sesión. Quita los que no reconozcas.',
            })}
          </Text>

          {loading && (
            <View className="items-center justify-center py-12">
              <ActivityIndicator size="large" color={colors.brand.orange} />
            </View>
          )}

          {!loading && error && (
            <EmptyState
              icon="cloud-offline-outline"
              title={t('devices.error_title', { defaultValue: 'No se pudieron cargar' })}
              description={t('devices.error_desc', { defaultValue: 'Revisa tu conexión e inténtalo de nuevo.' })}
            />
          )}

          {!loading && !error && devices.length === 0 && (
            <EmptyState
              icon="phone-portrait-outline"
              title={t('devices.empty_title', { defaultValue: 'Sin dispositivos' })}
              description={t('devices.empty', { defaultValue: 'No hay dispositivos registrados todavía.' })}
            />
          )}

          {!loading && !error && devices.length > 0 && (
            <View className="gap-3">
              {devices.map((device) => {
                const isCurrent = currentDeviceId != null && device.device_id === currentDeviceId;
                return (
                  <Card key={device.id} theme="light" variant="surface" padding="md">
                    <View className="flex-row items-center">
                      <View
                        className="w-10 h-10 rounded-xl items-center justify-center mr-3"
                        style={{
                          backgroundColor: isCurrent
                            ? `${midnightEmber.accent[500]}20`
                            : midnightEmber.screen.bg.sunken,
                        }}
                      >
                        <Ionicons
                          name={device.platform === 'web' ? 'desktop-outline' : 'phone-portrait-outline'}
                          size={20}
                          color={isCurrent ? midnightEmber.accent[500] : midnightEmber.screen.text.tertiary}
                        />
                      </View>

                      <View className="flex-1 mr-2">
                        <View className="flex-row items-center">
                          <Text variant="body" color="primary" className="font-semibold" numberOfLines={1}>
                            {deviceTitle(device)}
                          </Text>
                          {isCurrent && (
                            <View
                              className="ml-2 px-2 py-0.5 rounded-full"
                              style={{ backgroundColor: `${midnightEmber.accent[500]}20` }}
                            >
                              <Text variant="caption" color="accent">
                                {t('devices.this_device', { defaultValue: 'Este dispositivo' })}
                              </Text>
                            </View>
                          )}
                        </View>
                        {device.os_version != null && device.os_version !== '' && (
                          <Text variant="caption" style={{ color: midnightEmber.screen.text.tertiary }}>
                            {t('devices.os_version', { defaultValue: 'Versión' })}: {device.os_version}
                          </Text>
                        )}
                        <Text variant="caption" style={{ color: midnightEmber.screen.text.tertiary }}>
                          {t('devices.last_seen', { defaultValue: 'Visto por última vez' })}{' '}
                          {formatLastSeen(device.last_seen_at)}
                        </Text>
                      </View>

                      {!isCurrent && (
                        <Pressable
                          onPress={() => handleRemove(device)}
                          hitSlop={8}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingVertical: 8,
                            paddingHorizontal: 12,
                            borderRadius: midnightEmber.radius.input,
                            backgroundColor: `${midnightEmber.state.danger}1F`,
                            borderWidth: 1,
                            borderColor: `${midnightEmber.state.danger}4D`,
                            opacity: pressed ? 0.7 : 1,
                          })}
                          android_ripple={{ color: `${midnightEmber.state.danger}26` }}
                          accessibilityRole="button"
                          accessibilityLabel={t('devices.revoke', { defaultValue: 'Quitar' })}
                        >
                          <Ionicons name="trash-outline" size={16} color={midnightEmber.state.danger} />
                          <Text
                            variant="caption"
                            style={{ color: midnightEmber.state.danger, marginLeft: 6, fontWeight: '600' }}
                          >
                            {t('devices.revoke', { defaultValue: 'Quitar' })}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  </Card>
                );
              })}
            </View>
          )}

          {/* ── Sign out everywhere ── */}
          {!loading && !error && (
            <View className="mt-8">
              <Pressable
                onPress={handleSignOutAll}
                disabled={signingOut}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: 14,
                  borderRadius: midnightEmber.radius.input,
                  backgroundColor: `${midnightEmber.state.danger}1F`,
                  borderWidth: 1,
                  borderColor: `${midnightEmber.state.danger}4D`,
                  minHeight: 48,
                  opacity: signingOut ? 0.6 : pressed ? 0.7 : 1,
                })}
                android_ripple={{ color: `${midnightEmber.state.danger}26` }}
                accessibilityRole="button"
                accessibilityLabel={t('devices.sign_out_all_button', { defaultValue: 'Cerrar sesión en todos los dispositivos' })}
              >
                {signingOut ? (
                  <ActivityIndicator size="small" color={midnightEmber.state.danger} />
                ) : (
                  <Ionicons name="log-out-outline" size={18} color={midnightEmber.state.danger} />
                )}
                <Text
                  variant="body"
                  style={{ color: midnightEmber.state.danger, marginLeft: 8, fontWeight: '600' }}
                >
                  {t('devices.sign_out_all_button', { defaultValue: 'Cerrar sesión en todos los dispositivos' })}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Screen>
  );
}
