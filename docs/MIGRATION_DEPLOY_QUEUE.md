# Migration Deploy Queue

Migrations that have shipped in git but are **not yet applied to production** because the MCP guard blocked their auto-application during development. The frontend tolerates each one's absence with silent fallbacks (`42P01 undefined_table` / `42883 undefined_function`), so partial deploys don't break UX — but the features they back are operating in degraded mode until applied.

Apply in numeric order (dependencies are noted where they matter).

## Pending queue (as of 2026-05-05)

| # | Migration | Feature | Apply order | Notes |
|---|---|---|---|---|
| 1 | `00258_driver_personal_peak_hours.sql` | N2 — Personal peak-hours heatmap | First | RPC only, no schema deps. After apply: `PersonalPeakHours` heatmap on the earnings tab populates instead of hiding. |
| 2 | `00259_driver_recurring_shifts.sql` | D5 — Recurring shifts CRUD | Independent | Reuses `compute_next_occurrence(p_days, p_time, p_tz)` from migration `00047_recurring_rides.sql` — that function must already exist (it does in prod). |
| 3 | `00260_driver_performance_trend.sql` | N3 deep — Performance dashboard sparklines | Independent | RPC only. After apply: `/profile/performance` shows the 30-day acceptance/cancellation sparklines instead of the "Tendencia diaria no disponible aún" empty state. |
| 4 | `00261_driver_work_sessions.sql` | N6 DB-backed — cross-device fatigue timer + shift adherence | **After 00259** | The `get_driver_work_adherence` RPC joins `driver_recurring_shifts` (D5). Applying 00261 before 00259 would still work (the JOIN returns 0 planned minutes) but planning info would be missing until D5 lands. |

## How to apply

When ready to deploy:

```bash
# Via Supabase CLI (preferred — runs in transaction, validates against shadow DB)
supabase db push --include 00258,00259,00260,00261

# Or one at a time via the dashboard SQL editor, in order.
```

After each apply, run the verification snippets below.

## Verification snippets

### 00258 — `get_driver_peak_hours_personal`

```sql
-- Should return 0..N rows (zero is fine for new drivers).
SELECT * FROM get_driver_peak_hours_personal(
  '<any-driver-id>'::uuid, 30
) LIMIT 5;
```

Frontend signal: open the earnings tab as that driver — the "Tus mejores horas" heatmap section should now render.

### 00259 — `driver_recurring_shifts`

```sql
-- Table exists with the expected columns
\d driver_recurring_shifts

-- RLS enforced — should return 0 rows when called without an authenticated session
SELECT * FROM driver_recurring_shifts LIMIT 1;

-- Insert as a driver should work; cross-driver INSERT should fail
```

Frontend signal: Profile → "Turnos recurrentes" → create a new shift via the modal — should persist and survive an app reload.

### 00260 — `get_driver_performance_trend`

```sql
-- Returns p_days+1 rows including zero-rows for inactive days
SELECT day, completed_count, canceled_count, accepted_count, avg_response_time_s
FROM get_driver_performance_trend('<any-driver-id>'::uuid, 30)
ORDER BY day;
-- Expected: 31 rows
```

Frontend signal: Profile → "Mi desempeño" → the two sparkline cards (Aceptación + Cancelación) should render with bars.

### 00261 — `driver_work_sessions`

```sql
-- Trigger inserted a session when an online driver flipped is_online
SELECT id, started_at, ended_at, total_minutes_online
FROM driver_work_sessions
WHERE driver_id = '<currently-online-driver-id>'::uuid
ORDER BY started_at DESC LIMIT 3;
-- Expected: at least one row; the latest one should have ended_at NULL
-- if the driver is currently online.

-- Active session RPC
SELECT * FROM get_active_work_session('<online-driver-id>'::uuid);

-- Adherence RPC
SELECT * FROM get_driver_work_adherence('<driver-id>'::uuid, 14);
-- Expected: 15 rows (today + previous 14 days), `actual_minutes_online`
-- non-zero on days the driver worked, `planned_minutes` reflects D5
-- shift sums for that DOW.
```

Frontend signal: drive online → log out from the device → log in from a different device while still online → the fatigue banner timer should persist (cross-device proof).

## When this list is empty

When all four migrations are applied, delete this file. Future migration-deploy gaps should grow this file again from scratch.

## Cross-references

- The CLAUDE.md "Operación: deploys, migraciones y merges" section explains the **MCP guard pattern** these migrations were affected by.
- Each PR linked in the table has a "Frontend tolerates absence silently" note explaining the degradation behavior.
