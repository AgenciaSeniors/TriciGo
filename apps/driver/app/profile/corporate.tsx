// ============================================================
// TriciGo Driver — Corporate / Fleet entry point (Phase 4)
// The screen is shared with the passenger app: see
// packages/ui/src/fleet/FleetDashboard.tsx. This route supplies who
// the user is, the refresh on focus and the navigation.
// ============================================================

import React from 'react';
import { router } from 'expo-router';
import { FleetDashboard } from '@tricigo/ui/fleet/FleetDashboard';
import { useFleetScreen } from '@tricigo/ui/fleet/useFleetScreen';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';

export default function CorporateScreen() {
  const driverProfile = useDriverStore((s) => s.profile);
  const authUser = useAuthStore((s) => s.user);
  const userId = driverProfile?.user_id;
  const screen = useFleetScreen(userId);

  // Coming back from add-fleet-driver shows the driver just added.
  useRefreshOnFocus(screen.reload);

  return (
    <FleetDashboard
      screen={screen}
      userId={userId}
      ownerPhone={authUser?.phone ?? ''}
      onBack={() => router.back()}
      onAddDriver={(fleetId) => router.push({ pathname: '/profile/add-fleet-driver', params: { fleetId } })}
    />
  );
}
