// ============================================================
// TriciGo Driver — Corporate / Fleet entry point (Phase 4)
// Three states for the logged-in driver:
//   1. Belongs to one or more fleets (auto-linked or manually added)
//      → show one row per fleet with status + commission info.
//   2. Is the fleet owner (registered the fleet themselves) →
//      show fleet dashboard with members list + status.
//   3. None of the above → show FleetRequestForm so the driver
//      can submit a new fleet request.
// A fleet that was rejected is not a dashboard: when every request of
// the driver was rejected, the admin's reason and the form to apply
// again show below any fleets they drive for. Until both reads have
// succeeded once, the screen shows a skeleton or an error with retry,
// never the form: see src/utils/corporateScreen.ts.
// ============================================================

import React, { useState, useEffect, useCallback, useReducer, useRef } from 'react';
import { View, RefreshControl, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { SkeletonCard } from '@tricigo/ui/Skeleton';
import { ErrorState } from '@tricigo/ui/ErrorState';
import { ProfileScreenHeader } from '@tricigo/ui/ProfileScreenHeader';
import { midnightEmber, cubanLight, cubanDark, colors } from '@tricigo/theme';
import { fleetService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { logger } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import FleetRequestForm from '@/components/FleetRequestForm';
import FleetMembersList from '@/components/FleetMembersList';
import {
  corporateReducer,
  deriveCorporateView,
  fleetStatusBadge,
  initialCorporateState,
  rejectionReason,
  type CorporateAction,
} from '@/utils/corporateScreen';

export default function CorporateScreen() {
  const { t } = useTranslation('driver');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const driverProfile = useDriverStore((s) => s.profile);
  const authUser = useAuthStore((s) => s.user);
  const userId = driverProfile?.user_id;

  const [state, dispatch] = useReducer(corporateReducer, initialCorporateState);
  const [refreshing, setRefreshing] = useState(false);
  const nextLoad = useRef(0);

  // Reads both lookups as a numbered load. A failed read keeps its last
  // value, and only the latest load applies, so a slow older one cannot
  // overwrite a newer result.
  const runLoad = useCallback(
    async (start: (load: number) => CorporateAction) => {
      if (!userId) {
        setRefreshing(false);
        return;
      }
      const load = nextLoad.current++;
      dispatch(start(load));
      const [memberships, ownedFleet] = await Promise.allSettled([
        fleetService.getMembershipsForDriver(userId),
        fleetService.getFleetByOwner(userId),
      ]);
      if (memberships.status === 'rejected') {
        logger.warn('[Corporate] Failed to load fleet memberships', { error: String(memberships.reason) });
      }
      if (ownedFleet.status === 'rejected') {
        logger.warn('[Corporate] Failed to load owned fleet', { error: String(ownedFleet.reason) });
      }
      dispatch({ type: 'load_settled', load, memberships, ownedFleet });
    },
    [userId],
  );

  const fetchData = useCallback(() => runLoad((load) => ({ type: 'load_started', load })), [runLoad]);

  // The request exists now, so "no fleet" is no longer known: read it back.
  const handleRequestSubmitted = useCallback(() => {
    void runLoad((load) => ({ type: 'request_submitted', load }));
  }, [runLoad]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // The pull-to-refresh spinner stops once no load is running.
  useEffect(() => {
    if (state.load === null) setRefreshing(false);
  }, [state.load]);

  const view = deriveCorporateView(state);
  const ready = view.kind === 'ready' ? view : null;
  const memberships = ready?.memberships ?? [];
  const ownerFleet = ready?.ownerFleet ?? null;
  const rejectedRequest = ready?.rejectedRequest ?? null;
  const inSeveralFleets = memberships.length > 1;
  const ownerBadge = ownerFleet ? fleetStatusBadge(ownerFleet.account.status) : null;
  const reason = rejectedRequest ? rejectionReason(rejectedRequest.account.suspended_reason) : null;

  return (
    <Screen
      scroll
      bg={isDark ? 'dark' : 'white'}
      statusBarStyle={isDark ? 'light-content' : 'dark-content'}
      padded
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); void fetchData(); }}
          tintColor={colors.brand.orange}
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }}>
      <View className="pt-4 pb-8">
        <ProfileScreenHeader
          title="Corporativo"
          onBack={() => router.back()}
          backAccessibilityLabel="Atrás"
        />

        {view.kind === 'loading' && (
          <View className="gap-3">
            <SkeletonCard />
            <SkeletonCard />
          </View>
        )}

        {/* A read never succeeded, so "no fleet" is unknown: retry, never the form */}
        {view.kind === 'error' && (
          <ErrorState
            title={t('fleet.load_error_title', { defaultValue: 'No pudimos cargar tu información corporativa' })}
            description={t('fleet.load_error_body', { defaultValue: 'Revisa tu conexión a internet e inténtalo de nuevo.' })}
            retryLabel={t('common:retry', { defaultValue: 'Reintentar' })}
            onRetry={() => { void fetchData(); }}
          />
        )}

        {/* Member view: one row per fleet, since a driver can be in several */}
        {memberships.length > 0 && (
          <Card variant="outlined" padding="lg" className="mb-4">
            <Text variant="h4" className="mb-3">
              {inSeveralFleets ? 'Tus flotas' : 'Tu flota'}
            </Text>
            <Text variant="bodySmall" color="secondary" className="mb-3">
              {inSeveralFleets
                ? `Estás vinculado como conductor en ${memberships.length} flotas.`
                : 'Estás vinculado como conductor.'}{' '}
              Tus viajes corporativos aplicarán comisión reducida automáticamente — el pasajero paga menos y tú cobras lo mismo de siempre.
            </Text>
            <View className="gap-3">
              {memberships.map((m) => (
                <View
                  key={m.id}
                  className="flex-row items-center justify-between border-t border-neutral-100 dark:border-neutral-800 pt-3"
                >
                  <View className="flex-1 mr-2">
                    <Text variant="caption" color="secondary">Registrado como</Text>
                    <Text variant="body">{m.driver_name}</Text>
                    <Text variant="bodySmall" color="secondary">{m.driver_phone}</Text>
                  </View>
                  <StatusBadge
                    label={m.status === 'active' ? 'Activo' : 'Pendiente'}
                    variant={m.status === 'active' ? 'success' : 'warning'}
                  />
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* Owner dashboard */}
        {ownerFleet && ownerBadge && (
          <>
            <Card variant="outlined" padding="lg" className="mb-4">
              <View className="flex-row items-center justify-between mb-3">
                <Text variant="h4">{ownerFleet.fleet.name}</Text>
                <StatusBadge
                  label={t(ownerBadge.labelKey, { defaultValue: ownerBadge.label })}
                  variant={ownerBadge.variant}
                />
              </View>
              {ownerFleet.account.status === 'pending' && (
                <Text variant="bodySmall" color="secondary" className="mb-3">
                  Tu flota está en revisión. Recibirás una notificación cuando el equipo TriciGo la apruebe. Los conductores listados serán vinculados automáticamente cuando se registren con su número de teléfono.
                </Text>
              )}
              {ownerFleet.account.status === 'approved' && ownerFleet.account.commission_percent !== null && (
                <View className="border-t border-neutral-100 dark:border-neutral-800 pt-3 mb-2">
                  <Text variant="caption" color="secondary">Comisión asignada</Text>
                  <Text variant="h4" color="accent">{ownerFleet.account.commission_percent}%</Text>
                  <Text variant="caption" color="secondary">
                    Reducida vs. el {15}% estándar — pasajeros pagan menos.
                  </Text>
                </View>
              )}
            </Card>

            <Text variant="label" color="secondary" className="mb-2 ml-1">Conductores</Text>
            <Card variant="outlined" padding="lg" className="mb-4">
              <FleetMembersList members={ownerFleet.members} />
            </Card>
          </>
        )}

        {/* Every request was rejected: the admin's reason, then the form to apply again */}
        {rejectedRequest && (
          <Card variant="filled" padding="lg" className="mb-3 bg-error-light dark:bg-error/20">
            <View className="flex-row items-center gap-2 mb-2">
              <Ionicons name="close-circle-outline" size={20} color={colors.error.DEFAULT} />
              <Text variant="h4" color="error">
                {t('fleet.rejected_title', { defaultValue: 'Solicitud rechazada' })}
              </Text>
            </View>
            {reason && (
              <Text variant="bodySmall" color="secondary">
                {t('fleet.rejected_reason', { defaultValue: 'Motivo: {{reason}}', reason })}
              </Text>
            )}
            <Text variant="bodySmall" color="secondary" className="mt-2">
              {t('fleet.rejected_resubmit', {
                defaultValue: 'Puedes corregir los datos y volver a enviar la solicitud.',
              })}
            </Text>
          </Card>
        )}

        {/* No fleet, or a rejected request → form */}
        {ready?.showRequestForm && userId && (
          <FleetRequestForm
            ownerUserId={userId}
            ownerPhone={authUser?.phone ?? ''}
            onSubmitted={handleRequestSubmitted}
          />
        )}
      </View>
      </View>
    </Screen>
  );
}
