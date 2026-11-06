// ============================================================
// TriciGo Client — fleet of drivers (Phase 4)
// The screen is shared with the driver app: see
// packages/ui/src/fleet/FleetDashboard.tsx. This route supplies who
// the user is, the refresh on focus, the file picker, the toast and
// the navigation. A fleet_update push lands here too, so it also shows
// the card of a passenger who was linked to someone's fleet.
// ============================================================

import React from 'react';
import { useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { FleetDashboard } from '@tricigo/ui/fleet/FleetDashboard';
import { useFleetScreen } from '@tricigo/ui/fleet/useFleetScreen';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { pickFleetLicense } from '@/lib/pickFleetLicense';

export default function FleetScreen() {
  const { t } = useTranslation('driver');
  const router = useRouter();
  const authUser = useAuthStore((s) => s.user);
  const userId = authUser?.id;
  const screen = useFleetScreen(userId);

  // Coming back from add-fleet-driver or edit-fleet shows what changed.
  useRefreshOnFocus(screen.reload);

  return (
    <FleetDashboard
      screen={screen}
      userId={userId}
      // Empty when the session has none (Google or Apple): the form asks for it.
      ownerPhone={authUser?.phone ?? ''}
      screenBg="cuban"
      onBack={() => router.back()}
      onAddDriver={(fleet) =>
        router.push({
          pathname: '/profile/add-fleet-driver',
          params: { fleetId: fleet.id, corporateAccountId: fleet.corporate_account_id },
        })
      }
      onEditFleet={() => router.push('/profile/edit-fleet')}
      onPickLicense={() => pickFleetLicense(t)}
      onNotify={(kind, message) => Toast.show({ type: kind, text1: message })}
    />
  );
}
