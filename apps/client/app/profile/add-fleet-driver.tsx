// ============================================================
// TriciGo Client — add a driver to a fleet already sent
// The form is shared with the driver app: see
// packages/ui/src/fleet/AddFleetDriverForm.tsx. This route supplies
// the fleet, the file picker, the toast and the navigation.
// ============================================================

import React from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Toast from 'react-native-toast-message';
import { AddFleetDriverForm } from '@tricigo/ui/fleet/AddFleetDriverForm';
import { useTranslation } from '@tricigo/i18n';
import { pickFleetLicense } from '@/lib/pickFleetLicense';

export default function AddFleetDriverScreen() {
  const { t } = useTranslation('driver');
  const router = useRouter();
  const { fleetId, corporateAccountId } = useLocalSearchParams<{ fleetId: string; corporateAccountId: string }>();

  return (
    <AddFleetDriverForm
      fleetId={fleetId}
      corporateAccountId={corporateAccountId}
      screenBg="cuban"
      onBack={() => router.back()}
      onPickLicense={() => pickFleetLicense(t)}
      onAdded={({ licenseFailed }) => {
        if (licenseFailed) {
          Toast.show({
            type: 'info',
            text1: t('fleet.add_driver_license_failed', {
              defaultValue: 'Conductor agregado, pero la licencia no se subió. Súbela desde su fila en la lista.',
            }),
          });
        } else {
          Toast.show({ type: 'success', text1: t('fleet.add_driver_done', { defaultValue: 'Conductor agregado' }) });
        }
        router.back();
      }}
    />
  );
}
