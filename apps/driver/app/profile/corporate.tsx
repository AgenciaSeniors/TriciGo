// ============================================================
// TriciGo Driver — Corporate / Fleet entry point (Phase 4)
// The screen is shared with the passenger app: see
// packages/ui/src/fleet/FleetDashboard.tsx. This route supplies who
// the user is, the refresh on focus, the file picker, the toast and
// the navigation.
// ============================================================

import React from 'react';
import { router } from 'expo-router';
import Toast from 'react-native-toast-message';
import { FleetDashboard } from '@tricigo/ui/fleet/FleetDashboard';
import { useFleetScreen } from '@tricigo/ui/fleet/useFleetScreen';
import { useTranslation } from '@tricigo/i18n';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { pickFleetLicense } from '@/lib/pickFleetLicense';

export default function CorporateScreen() {
  const { t } = useTranslation('driver');
  const driverProfile = useDriverStore((s) => s.profile);
  const authUser = useAuthStore((s) => s.user);
  const userId = driverProfile?.user_id;
  const screen = useFleetScreen(userId);

  // Coming back from add-fleet-driver or edit-fleet shows what changed.
  useRefreshOnFocus(screen.reload);

  return (
    <FleetDashboard
      screen={screen}
      userId={userId}
      ownerPhone={authUser?.phone ?? ''}
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
