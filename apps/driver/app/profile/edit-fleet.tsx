// ============================================================
// TriciGo Driver — edit the details of the owner's fleet
// The form is shared with the passenger app: see
// packages/ui/src/fleet/FleetEditForm.tsx. This route supplies who the
// user is, the toast and the navigation.
// ============================================================

import React from 'react';
import { router } from 'expo-router';
import Toast from 'react-native-toast-message';
import { FleetEditForm } from '@tricigo/ui/fleet/FleetEditForm';
import { useFleetScreen } from '@tricigo/ui/fleet/useFleetScreen';
import { useTranslation } from '@tricigo/i18n';
import { useDriverStore } from '@/stores/driver.store';

export default function EditFleetScreen() {
  const { t } = useTranslation('driver');
  const userId = useDriverStore((s) => s.profile?.user_id);
  const screen = useFleetScreen(userId);

  return (
    <FleetEditForm
      screen={screen}
      onBack={() => router.back()}
      onSaved={() => {
        Toast.show({ type: 'success', text1: t('fleet.edit_done', { defaultValue: 'Datos de la flota guardados' }) });
        router.back();
      }}
    />
  );
}
