// ============================================================
// TriciGo Client — edit the details of the owner's fleet
// The form is shared with the driver app: see
// packages/ui/src/fleet/FleetEditForm.tsx. This route supplies who the
// user is, the toast and the navigation.
// ============================================================

import React from 'react';
import { useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { FleetEditForm } from '@tricigo/ui/fleet/FleetEditForm';
import { useFleetScreen } from '@tricigo/ui/fleet/useFleetScreen';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';

export default function EditFleetScreen() {
  const { t } = useTranslation('driver');
  const router = useRouter();
  const userId = useAuthStore((s) => s.user?.id);
  const screen = useFleetScreen(userId);

  return (
    <FleetEditForm
      screen={screen}
      screenBg="cuban"
      onBack={() => router.back()}
      onSaved={() => {
        Toast.show({ type: 'success', text1: t('fleet.edit_done', { defaultValue: 'Datos de la flota guardados' }) });
        router.back();
      }}
    />
  );
}
