'use client';

/**
 * The driver's vehicle type on the assist page. Outlined, so it reads apart from the tinted
 * status chips next to it (online, busy, no balance).
 */

import { useTranslation } from '@tricigo/i18n';
import type { VehicleType } from '@tricigo/types';
import { VEHICLE_TYPE_LABEL, labelFor } from '@/lib/labels';

/** The order the assist page lists vehicle types in, smallest first. */
export const VEHICLE_TYPE_ORDER: readonly VehicleType[] = ['triciclo', 'moto', 'auto', 'confort'];

export function VehicleTypeChip({ type }: { type: VehicleType }) {
  const { t } = useTranslation('admin');
  return (
    <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-semibold text-ink">
      {labelFor(t, VEHICLE_TYPE_LABEL, type)}
    </span>
  );
}
