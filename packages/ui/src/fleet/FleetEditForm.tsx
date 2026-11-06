// ============================================================
// TriciGo — edit the details of the owner's fleet, in both apps
// Opened from the owner dashboard. The fleet comes from useFleetScreen
// (the route passes the same hook result as the dashboard) and the
// fields start from it once, so a reload while the owner types never
// overwrites what they wrote. The checks are in
// packages/utils/src/fleet/fleetEditForm.ts; fleetService.updateFleet
// writes, and a 0-row answer is an error there, never a silent success.
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View, useColorScheme } from 'react-native';
import { cubanDark, cubanLight } from '@tricigo/theme';
import { fleetService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import type { DriverFleet } from '@tricigo/types';
import {
  fleetEditErrorTexts,
  fleetEditFormFromFleet,
  parseFleetEditForm,
  type FleetEditFormErrors,
  type FleetEditFormValues,
} from '@tricigo/utils/fleet/fleetEditForm';
import { fleetActionFailure } from '@tricigo/utils/fleet/fleetMemberActions';
import { FLEET_VEHICLE_TYPES } from '@tricigo/utils/fleet/fleetRequestForm';
import { Screen, type ScreenProps } from '../Screen';
import { Button } from '../Button';
import { Input } from '../Input';
import { Text } from '../Text';
import { Card } from '../Card';
import { ErrorState } from '../ErrorState';
import { SkeletonCard } from '../Skeleton';
import { ProfileScreenHeader } from '../ProfileScreenHeader';
import { announce } from './announce';
import type { FleetScreen } from './useFleetScreen';

export interface FleetEditFormProps {
  /** What useFleetScreen returned for this user. */
  screen: FleetScreen;
  onBack: () => void;
  /** The details were saved: the route says so and leaves the screen. */
  onSaved: () => void;
  /**
   * Background of the screen. Left out, the screen looks like the driver app's
   * other profile screens. The passenger app passes 'cuban', like its own. The
   * panel inside paints the same paper color, so with 'cuban' it does not show.
   */
  screenBg?: ScreenProps['bg'];
}

function Chip({ selected, onPress, label }: { selected: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      <View
        className={`px-3 rounded-lg border ${
          selected
            ? 'bg-primary-500 border-primary-500'
            : 'bg-white dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
        }`}
        style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }}
      >
        <Text variant="caption" color={selected ? 'inverse' : 'secondary'}>{label}</Text>
      </View>
    </Pressable>
  );
}

function FleetEditFields({
  fleet,
  onSaved,
  onBack,
  screenBg,
}: {
  fleet: DriverFleet;
  onBack: () => void;
  onSaved: () => void;
  screenBg?: ScreenProps['bg'];
}) {
  const { t } = useTranslation('driver');
  const isDark = useColorScheme() === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const [form, setForm] = useState<FleetEditFormValues>(() => fleetEditFormFromFleet(fleet));
  const [errors, setErrors] = useState<FleetEditFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setField = (field: Exclude<keyof FleetEditFormValues, 'vehicleTypes'>) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setSubmitError(null);
  };

  const toggleVehicleType = (id: string) => {
    setForm((prev) => ({
      ...prev,
      vehicleTypes: prev.vehicleTypes.includes(id)
        ? prev.vehicleTypes.filter((v) => v !== id)
        : [...prev.vehicleTypes, id],
    }));
    setErrors((prev) => ({ ...prev, vehicleTypes: undefined }));
    setSubmitError(null);
  };

  const handleSave = async () => {
    const parsed = parseFleetEditForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      // The fields at fault can be out of view: this line sits by the button.
      setSubmitError(t('fleet.add_driver_fix_fields', { defaultValue: 'Revisa los campos marcados.' }));
      announce(Object.values(fleetEditErrorTexts(parsed.errors, t)).join(' '));
      return;
    }
    setErrors({});
    setSubmitError(null);
    setSaving(true);
    try {
      await fleetService.updateFleet(fleet, parsed.patch);
      onSaved();
    } catch (err) {
      const message =
        fleetActionFailure(err) === 'not_updated'
          ? t('fleet.edit_not_updated', {
              defaultValue: 'No se pudieron guardar los cambios. Vuelve a la lista, actualízala e inténtalo de nuevo.',
            })
          : t('fleet.edit_failed', {
              defaultValue: 'No se pudieron guardar los cambios. Revisa tu conexión e inténtalo de nuevo.',
            });
      setSubmitError(message);
      announce(message);
    } finally {
      setSaving(false);
    }
  };

  const errorTexts = fleetEditErrorTexts(errors, t);

  return (
    <Screen
      bg={screenBg ?? (isDark ? 'dark' : 'white')}
      statusBarStyle={isDark ? 'light-content' : 'dark-content'}
      padded={false}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1, backgroundColor: palette.bg.paper }}
      >
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View className="px-4 pt-4 pb-8">
            <ProfileScreenHeader
              title={t('fleet.edit_fleet', { defaultValue: 'Editar datos de la flota' })}
              onBack={onBack}
              backAccessibilityLabel={t('common:back', { defaultValue: 'Volver' })}
            />

            <Card variant="outlined" padding="lg" className="mb-3">
              <Input
                label={t('fleet.request_fleet_name', { defaultValue: 'Nombre de la flota *' })}
                value={form.name}
                onChangeText={setField('name')}
                error={errorTexts.name}
                accessibilityHint={errorTexts.name}
              />
              <View className="h-3" />
              <Input
                label={t('fleet.request_city', { defaultValue: 'Ciudad / municipio principal *' })}
                value={form.city}
                onChangeText={setField('city')}
                maxLength={120}
                error={errorTexts.city}
                accessibilityHint={errorTexts.city}
              />
            </Card>

            <Card variant="outlined" padding="lg" className="mb-3">
              <Text variant="caption" color="secondary" className="mb-2">
                {t('fleet.request_vehicle_types', { defaultValue: 'Tipos *' })}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {FLEET_VEHICLE_TYPES.map((v) => (
                  <Chip
                    key={v.id}
                    selected={form.vehicleTypes.includes(v.id)}
                    onPress={() => toggleVehicleType(v.id)}
                    label={t(`fleet.vehicle_type.${v.id}`, { defaultValue: v.label })}
                  />
                ))}
              </View>
              {errorTexts.vehicleTypes && (
                <Text variant="caption" color="error" className="mt-2">{errorTexts.vehicleTypes}</Text>
              )}
              <View className="h-3" />
              <Input
                label={t('fleet.request_vehicle_count', { defaultValue: 'Cantidad estimada' })}
                value={form.vehicleCount}
                onChangeText={setField('vehicleCount')}
                keyboardType="numeric"
                error={errorTexts.vehicleCount}
                accessibilityHint={errorTexts.vehicleCount}
              />
              <View className="h-3" />
              <Input
                label={t('fleet.request_zones', { defaultValue: 'Zonas que cubren (separadas por coma)' })}
                value={form.zones}
                onChangeText={setField('zones')}
              />
            </Card>

            <Card variant="outlined" padding="lg" className="mb-3">
              <Text variant="caption" color="secondary" className="mb-1">
                {t('fleet.request_hours', { defaultValue: 'Horario habitual (HH:MM)' })}
              </Text>
              {/* Aligned at the top: an error under one field must not move the other */}
              <View className="flex-row items-start gap-2 mb-3">
                <View className="flex-1">
                  <Input
                    value={form.hoursStart}
                    onChangeText={setField('hoursStart')}
                    placeholder="06:00"
                    error={errorTexts.hoursStart}
                    accessibilityHint={errorTexts.hoursStart}
                  />
                </View>
                <Text variant="body" color="secondary" className="mt-3">—</Text>
                <View className="flex-1">
                  <Input
                    value={form.hoursEnd}
                    onChangeText={setField('hoursEnd')}
                    placeholder="22:00"
                    error={errorTexts.hoursEnd}
                    accessibilityHint={errorTexts.hoursEnd}
                  />
                </View>
              </View>
              <Input
                label={t('fleet.request_rides_per_day', { defaultValue: 'Viajes estimados por día (por vehículo)' })}
                value={form.ridesPerDay}
                onChangeText={setField('ridesPerDay')}
                keyboardType="numeric"
                error={errorTexts.ridesPerDay}
                accessibilityHint={errorTexts.ridesPerDay}
              />
            </Card>

            {submitError && (
              <Text variant="bodySmall" color="error" className="mb-3">
                {submitError}
              </Text>
            )}

            <Button
              title={t('fleet.edit_save', { defaultValue: 'Guardar cambios' })}
              variant="primary"
              size="lg"
              fullWidth
              loading={saving}
              disabled={saving}
              onPress={handleSave}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function FleetEditForm({ screen, onBack, onSaved, screenBg }: FleetEditFormProps) {
  const { t } = useTranslation('driver');
  const isDark = useColorScheme() === 'dark';
  const { view, reload } = screen;
  const fleet = view.kind === 'ready' ? view.ownerFleet?.fleet ?? null : null;

  // Keyed by the fleet, and rendered once it exists, so the fields start from it.
  if (fleet) {
    return <FleetEditFields key={fleet.id} fleet={fleet} onBack={onBack} onSaved={onSaved} screenBg={screenBg} />;
  }

  return (
    <Screen
      bg={screenBg ?? (isDark ? 'dark' : 'white')}
      statusBarStyle={isDark ? 'light-content' : 'dark-content'}
      padded
    >
      <View className="pt-4">
        <ProfileScreenHeader
          title={t('fleet.edit_fleet', { defaultValue: 'Editar datos de la flota' })}
          onBack={onBack}
          backAccessibilityLabel={t('common:back', { defaultValue: 'Volver' })}
        />
        {view.kind === 'loading' ? (
          <SkeletonCard />
        ) : (
          // An error, or no fleet of the owner: nothing to edit.
          <ErrorState
            title={t('fleet.load_error_title', { defaultValue: 'No pudimos cargar tu información corporativa' })}
            description={t('fleet.load_error_body', { defaultValue: 'Revisa tu conexión a internet e inténtalo de nuevo.' })}
            retryLabel={t('common:retry', { defaultValue: 'Reintentar' })}
            onRetry={() => { void reload(); }}
          />
        )}
      </View>
    </Screen>
  );
}
