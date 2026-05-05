// ============================================================
// TriciGo — Driver Recurring Shift Types (Phase 1 D5)
// ============================================================

export type DriverRecurringShiftStatus = 'active' | 'paused' | 'deleted';

/**
 * A driver's recurring availability window. The driver pre-defines
 * their typical work shifts (e.g. "Mon–Fri 7am–3pm in Vedado") and
 * the system uses them to:
 *   - notify ~15 min before each scheduled shift starts
 *   - surface "your usual shift starts in 12 min" prompts on home
 *   - measure shift adherence (planned vs actual online time)
 *
 * Backed by `driver_recurring_shifts` (migration 00259).
 */
export interface DriverRecurringShift {
  id: string;
  driver_id: string;

  /** Optional friendly label like "Mañana Vedado" or "Turno noche". */
  label: string | null;

  /** ISO days: 1=Mon..7=Sun. */
  days_of_week: number[];

  /** Local time HH:MM, interpreted in `timezone`. */
  start_time: string;
  /** Local time HH:MM, interpreted in `timezone`. Must differ from start. */
  end_time: string;

  /** Optional preferred operating zone for routing hints when the shift fires. */
  preferred_zone_id: string | null;

  timezone: string;

  status: DriverRecurringShiftStatus;
  next_occurrence_at: string | null;
  last_notified_at: string | null;

  created_at: string;
  updated_at: string;
}
