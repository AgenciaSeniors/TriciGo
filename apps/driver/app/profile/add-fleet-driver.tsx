// ============================================================
// TriciGo Driver — add a driver to a fleet already sent
// The form is shared with the passenger app: see
// packages/ui/src/fleet/AddFleetDriverForm.tsx. This route supplies
// the fleet, the toast and the navigation.
// ============================================================

import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { AddFleetDriverForm } from '@tricigo/ui/fleet/AddFleetDriverForm';
import { useTranslation } from '@tricigo/i18n';

export default function AddFleetDriverScreen() {
  const { t } = useTranslation('driver');
  const { fleetId } = useLocalSearchParams<{ fleetId: string }>();

  return (
    <AddFleetDriverForm
      fleetId={fleetId}
      onBack={() => router.back()}
      onAdded={() => {
        Toast.show({ type: 'success', text1: t('fleet.add_driver_done', { defaultValue: 'Conductor agregado' }) });
        router.back();
      }}
    />
  );
}
