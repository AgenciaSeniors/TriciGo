'use client';

import { useCallback } from 'react';
import { panelCan, type PanelCapability } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from './panelRole';

/**
 * What the signed-in role may do on the page (00668), and whether the role is known yet.
 * Pages that read different data by role wait for `ready`. It only shapes the UI: the server
 * refuses every action on its own.
 */
export function usePanelCan(): { can: (cap: PanelCapability) => boolean; ready: boolean } {
  const { role, loading } = usePanelRole();
  const can = useCallback((cap: PanelCapability) => panelCan(role, cap), [role]);
  return { can, ready: !loading };
}
