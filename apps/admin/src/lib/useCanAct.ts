'use client';

import { panelCanAct } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from './panelRole';

/**
 * Whether the page shows actions, and whether the role is known yet (00663). Marketing only
 * reads, except on /support. Pages that read different data by role wait for `ready`.
 */
export function useCanAct(): { canAct: boolean; ready: boolean } {
  const { role, loading } = usePanelRole();
  return { canAct: panelCanAct(role), ready: !loading };
}
