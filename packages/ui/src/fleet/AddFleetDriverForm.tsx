// ============================================================
// TriciGo — add a driver to a fleet already sent, in both apps
// Opened from the owner dashboard, which reads the fleet again when
// it regains focus. The driver joins the list pending review, like
// the ones in the request: TriciGo reviews each one and links them
// once they sign up with that number.
// A screen and not a sheet: with five fields the keyboard covers
// the lower ones, and this is the layout the onboarding forms use.
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View, useColorScheme } from 'react-native';
import { cubanDark, cubanLight } from '@tricigo/theme';
import { fleetService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import {
  addDriverFailure,
  emptyFleetMemberForm,
  fleetMemberErrorTexts,
  parseFleetMemberForm,
  type FleetMemberFormErrors,
  type FleetMemberFormValues,
} from '@tricigo/utils/fleet/fleetMemberForm';
import { Screen, type ScreenProps } from '../Screen';
import { Button } from '../Button';
import { Input } from '../Input';
import { Text } from '../Text';
import { ProfileScreenHeader } from '../ProfileScreenHeader';
import { announce } from './announce';
import type { FleetLicensePicker, PickedLicense } from './FleetMembersList';

export interface AddFleetDriverFormProps {
  fleetId: string;
  /** The company of the fleet: where the licence file is stored. */
  corporateAccountId: string;
  onBack: () => void;
  /** Opens the app's picker for a licence photo or PDF; null when cancelled. */
  onPickLicense: FleetLicensePicker;
  /**
   * The driver was saved: the route says so and leaves the screen.
   * `licenseFailed` is true when a licence was attached but did not upload:
   * the driver is in the list and the owner uploads it from their row.
   */
  onAdded: (outcome: { licenseFailed: boolean }) => void;
  /**
   * Background of the screen. Left out, the screen looks like the driver app's
   * other profile screens. The passenger app passes 'cuban', like its own. The
   * panel inside paints the same paper color, so with 'cuban' it does not show.
   */
  screenBg?: ScreenProps['bg'];
}

export function AddFleetDriverForm({
  fleetId,
  corporateAccountId,
  onBack,
  onPickLicense,
  onAdded,
  screenBg,
}: AddFleetDriverFormProps) {
  const { t } = useTranslation('driver');
  const isDark = useColorScheme() === 'dark';
  const palette = isDark ? cubanDark : cubanLight;

  const [form, setForm] = useState<FleetMemberFormValues>(emptyFleetMemberForm);
  const [errors, setErrors] = useState<FleetMemberFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The licence is optional: it is picked here and uploaded once the driver is saved.
  const [license, setLicense] = useState<PickedLicense | null>(null);

  const setField = (field: keyof FleetMemberFormValues) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setSubmitError(null);
  };

  const pickLicense = async () => {
    try {
      const picked = await onPickLicense();
      if (picked) setLicense(picked);
    } catch {
      const message = t('fleet.add_driver_license_pick_failed', {
        defaultValue: 'No se pudo abrir el selector. Puedes subir la licencia después, desde la lista.',
      });
      setSubmitError(message);
      announce(message);
    }
  };

  const handleAdd = async () => {
    const parsed = parseFleetMemberForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      // The fields at fault can be out of view: this line sits by the button.
      setSubmitError(t('fleet.add_driver_fix_fields', { defaultValue: 'Revisa los campos marcados.' }));
      announce(Object.values(fleetMemberErrorTexts(parsed.errors, t)).join(' '));
      return;
    }
    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    // The driver is saved by addMember. From then on the form must not save
    // again: a failed licence upload leaves the screen too, so it cannot add
    // the same driver twice.
    let saved: { id: string };
    try {
      saved = await fleetService.addMember(fleetId, parsed.member);
    } catch (err) {
      const message =
        addDriverFailure(err) === 'exists'
          ? t('fleet.add_driver_exists', { defaultValue: 'Ese teléfono ya está en tu flota.' })
          : t('fleet.add_driver_failed', {
              defaultValue: 'No se pudo agregar al conductor. Revisa tu conexión e inténtalo de nuevo.',
            });
      setSubmitError(message);
      announce(message);
      setSubmitting(false);
      return;
    }

    let licenseFailed = false;
    if (license) {
      try {
        await fleetService.uploadMemberLicenseFromUri({
          fleet_member_id: saved.id,
          corporate_account_id: corporateAccountId,
          uri: license.uri,
          file_name: license.file_name,
          mime_type: license.mime_type,
        });
      } catch {
        licenseFailed = true;
      }
    }
    setSubmitting(false);
    onAdded({ licenseFailed });
  };

  const errorTexts = fleetMemberErrorTexts(errors, t);

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
              title={t('fleet.add_driver', { defaultValue: 'Agregar conductor' })}
              onBack={onBack}
              backAccessibilityLabel={t('common:back', { defaultValue: 'Volver' })}
            />

            <Text variant="bodySmall" color="secondary" className="mb-4">
              {t('fleet.add_driver_intro', {
                defaultValue: 'TriciGo lo revisa y se vincula a tu flota cuando se registre con este teléfono.',
              })}
            </Text>

            <Input
              label={t('fleet.add_driver_name', { defaultValue: 'Nombre completo *' })}
              value={form.name}
              onChangeText={setField('name')}
              error={errorTexts.name}
              accessibilityHint={errorTexts.name}
            />
            <Input
              label={t('fleet.add_driver_phone', { defaultValue: 'Teléfono *' })}
              value={form.phone}
              onChangeText={setField('phone')}
              keyboardType="phone-pad"
              placeholder={t('fleet.phone_placeholder', { defaultValue: '+53 5XXXXXXX o 6XXXXXXX' })}
              error={errorTexts.phone}
              accessibilityHint={errorTexts.phone}
            />
            <Input
              label={t('fleet.add_driver_email', { defaultValue: 'Email' })}
              value={form.email}
              onChangeText={setField('email')}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Input
              label={t('fleet.add_driver_license', { defaultValue: 'Nº de licencia' })}
              value={form.license}
              onChangeText={setField('license')}
            />
            <Input
              label={t('fleet.add_driver_id_number', { defaultValue: 'Carné de identidad' })}
              value={form.idNumber}
              onChangeText={setField('idNumber')}
            />

            <View className="mb-4">
              <Text variant="caption" color="secondary" className="mb-1">
                {t('fleet.add_driver_license_photo', { defaultValue: 'Foto de la licencia (opcional)' })}
              </Text>
              <Button
                title={
                  license
                    ? t('fleet.add_driver_license_change', {
                        defaultValue: 'Cambiar: {{name}}',
                        name: license.file_name,
                      })
                    : t('fleet.add_driver_license_attach', { defaultValue: 'Adjuntar licencia' })
                }
                variant="outline"
                fullWidth
                disabled={submitting}
                onPress={pickLicense}
              />
            </View>

            {submitError && (
              <Text variant="bodySmall" color="error" className="mb-3">
                {submitError}
              </Text>
            )}

            <Button
              title={t('fleet.add_driver', { defaultValue: 'Agregar conductor' })}
              variant="primary"
              size="lg"
              fullWidth
              loading={submitting}
              disabled={submitting}
              onPress={handleAdd}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
