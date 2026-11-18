/**
 * Reconnects a driver the system took offline while the app showed "En línea".
 * The decisions live in services/systemOfflineRecovery.ts (tested); this hook
 * wires them to the app: the server row, AppState, the driver store and toasts.
 *
 * Four triggers:
 *  1. The 2-min heartbeat on the home screen reads is_online back and passes
 *     the row in (the app thinks it is online; the server may not).
 *  2. A server row arriving in the store (realtime, profile reload) that says
 *     offline while the app is on shift. A system drop does not end the shift
 *     (driver.store), so the background service keeps running while this runs.
 *  3. The app coming back to the foreground with a pending drop, or while it
 *     shows the driver online.
 *  4. The internet coming back while on shift (NetInfo), so the reconnect does
 *     not wait for the next 2-min heartbeat.
 */
import { useEffect, useMemo } from 'react';
import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import NetInfo from '@react-native-community/netinfo';
import Toast from 'react-native-toast-message';
import { driverService, getSupabaseClient, serverNowMs } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { logger, trackEvent } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { LOCATION_TASK } from '@/services/locationBackgroundTask';
import {
  createSystemOfflineRecovery,
  internetCameBack,
  serverRowNeedsRecovery,
  type ServerOnlineState,
} from '@/services/systemOfflineRecovery';

export type SystemOfflineRecovery = ReturnType<typeof createSystemOfflineRecovery>;

export function useSystemOfflineRecovery(profileId: string | undefined): SystemOfflineRecovery | null {
  const { t } = useTranslation('driver');

  const recovery = useMemo(() => {
    if (!profileId) return null;
    return createSystemOfflineRecovery({
      async fetchServerState() {
        try {
          const { data, error } = await getSupabaseClient()
            .from('driver_profiles')
            .select('is_online, auto_offline_at')
            .eq('id', profileId)
            .maybeSingle();
          if (error || !data) return null;
          return data as ServerOnlineState;
        } catch {
          return null;
        }
      },
      isAppActive: () => AppState.currentState === 'active',
      async isBackgroundServiceRunning() {
        if (Platform.OS === 'web') return false;
        // Location updates started for the task: the foreground service that
        // keeps heartbeating. A proxy (it cannot tell that batches still
        // arrive), but the one the OS gives us.
        return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
      },
      isOnShift: () => {
        const s = useDriverStore.getState();
        return s.isOnline && !s.shiftChangeInFlight;
      },
      nowMs: () => serverNowMs(),
      async blockedReason() {
        if (useDriverStore.getState().profile?.is_financially_eligible === false) return 'negative_balance';
        if (Platform.OS !== 'web') {
          try {
            const { status } = await Location.getForegroundPermissionsAsync();
            if (status !== 'granted') return 'location_permission';
          } catch {
            return 'location_permission';
          }
        }
        return null;
      },
      async goOnline() {
        await driverService.setOnlineStatus(profileId, true, undefined);
        useDriverStore.getState().setOnline(true);
      },
      onReconnected() {
        trackEvent('driver_auto_reconnected');
        logger.info('[OfflineRecovery] Reconnected a driver the system took offline', { driver_id: profileId });
        Toast.show({
          type: 'success',
          text1: t('home.reconnected_title', { defaultValue: 'Te volvimos a conectar' }),
          text2: t('home.reconnected_body', {
            defaultValue: 'Se perdió la señal un momento. Sigues recibiendo viajes.',
          }),
          visibilityTime: 4000,
        });
      },
      onShownOffline(reason, detail) {
        const store = useDriverStore.getState();
        const wasShowingOnline = store.isOnline;
        if (wasShowingOnline) store.setOnline(false);
        logger.warn('[OfflineRecovery] Showing the driver offline', { driver_id: profileId, reason, detail });
        if (reason === 'offline') {
          // A person took the driver offline (another device, an admin). Only
          // explain it when the app was still showing "En línea".
          if (!wasShowingOnline) return;
          Toast.show({
            type: 'info',
            text1: t('home.offline_detected_title', { defaultValue: 'Estás desconectado' }),
            text2: t('home.offline_detected_body', {
              defaultValue: 'Tu turno se cerró. Toca Conectarme para volver a recibir viajes.',
            }),
            visibilityTime: 5000,
          });
          return;
        }
        const raw = detail ?? '';
        const body =
          reason === 'failed' && /driver_has_no_active_vehicle/.test(raw)
            ? t('driver.online_needs_vehicle', { defaultValue: 'Registra tu vehículo antes de conectarte.' })
            : t('home.signal_lost_body', {
                defaultValue: 'Perdimos tu señal y no pudimos volver a conectarte. Toca Conectarme.',
              });
        Toast.show({
          type: 'error',
          text1: t('home.signal_lost_title', { defaultValue: 'Te desconectamos' }),
          text2: body,
          visibilityTime: 6000,
        });
      },
    });
  }, [profileId, t]);

  // (2) A server row that says offline while the app is on shift.
  useEffect(() => {
    if (!recovery) return;
    return useDriverStore.subscribe((state, prev) => {
      // setOnline() from the driver's own toggle keeps the same profile
      // object; only a row from the server replaces it.
      if (!serverRowNeedsRecovery(state, prev, profileId)) return;
      // A fresh read decides: the row in the store may come from the cache,
      // and the server restore is a second row right behind this one.
      void recovery.evaluate();
    });
  }, [recovery, profileId]);

  // (3) Back to the foreground.
  useEffect(() => {
    if (!recovery) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (recovery.hasPending() || useDriverStore.getState().isOnline) void recovery.evaluate();
    });
    return () => sub.remove();
  }, [recovery]);

  // (4) The internet came back while on shift.
  useEffect(() => {
    if (!recovery || Platform.OS === 'web') return;
    let prev: { isConnected: boolean | null; isInternetReachable?: boolean | null } | null = null;
    const unsubscribe = NetInfo.addEventListener((next) => {
      const cameBack = internetCameBack(prev, next);
      prev = { isConnected: next.isConnected, isInternetReachable: next.isInternetReachable };
      if (cameBack && useDriverStore.getState().isOnline) void recovery.evaluate();
    });
    return () => unsubscribe();
  }, [recovery]);

  return recovery;
}
