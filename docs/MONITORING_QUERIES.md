# Monitoring Queries — TriciGo Production Health

> **Audiencia**: Founder + on-call engineer + analytics.
> **Uso**: copiar query en Supabase SQL Editor o conectar via `psql` para health checks rutinarios.
> **Frecuencia recomendada**: diario para business metrics, on-demand para incident diagnosis.

---

## Tabla de queries

| Sección | Query | Frecuencia |
|---|---|---|
| §1 | Business health (DAU drivers/riders, ride volume) | Diario |
| §2 | Operational health (completion rate, cancellation rate) | Diario |
| §3 | Financial health (revenue, fees, wallet balance integrity) | Diario |
| §4 | Fraud detection (drivers anómalos) | Semanal |
| §5 | Performance (slow queries, EF latency) | On-demand |
| §6 | Concurrency (active rides per driver — should always be 1) | Daily alert |
| §7 | Cron job health | Daily |

---

## §1 — Business health

### Daily Active Users (DAU)

```sql
-- DAU last 7 days
SELECT
  DATE(created_at) AS date,
  COUNT(DISTINCT customer_id) FILTER (WHERE customer_id IS NOT NULL) AS active_riders,
  COUNT(DISTINCT driver_id) FILTER (WHERE driver_id IS NOT NULL) AS active_drivers,
  COUNT(*) AS rides_total
FROM rides
WHERE created_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 1 DESC;
```

### Rides per hour (peak detection)

```sql
SELECT
  DATE_TRUNC('hour', created_at) AS hour,
  COUNT(*) AS rides,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM rides
WHERE created_at > now() - interval '48 hours'
GROUP BY 1
ORDER BY 1 DESC;
```

### Top pickup zones (where demand concentrates)

```sql
SELECT
  ROUND(ST_X(pickup_location::geometry)::numeric, 3) AS lng,
  ROUND(ST_Y(pickup_location::geometry)::numeric, 3) AS lat,
  COUNT(*) AS pickups
FROM rides
WHERE created_at > now() - interval '7 days'
  AND status = 'completed'
GROUP BY 1, 2
HAVING COUNT(*) > 5
ORDER BY 3 DESC
LIMIT 20;
```

---

## §2 — Operational health

### Completion rate (target >85%)

```sql
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS requested,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  COUNT(*) FILTER (WHERE status = 'expired') AS expired,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'completed') / COUNT(*), 1) AS completion_rate_pct
FROM rides
WHERE created_at > now() - interval '7 days'
  AND status <> 'searching'  -- still in flight
GROUP BY 1
ORDER BY 1 DESC;
```

**Alert**: si completion_rate_pct < 70% por 3 días consecutivos → investigar matching / driver supply.

### Cancellation breakdown (quién cancela?)

```sql
SELECT
  DATE(created_at) AS date,
  cancelled_by,  -- 'customer' | 'driver' | 'system'
  cancel_reason,
  COUNT(*) AS count
FROM rides
WHERE status = 'cancelled'
  AND created_at > now() - interval '7 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;
```

### Driver acceptance rate

```sql
SELECT
  d.id AS driver_id,
  u.full_name,
  COUNT(o.id) AS offers_received,
  COUNT(*) FILTER (WHERE o.status = 'accepted') AS accepted,
  COUNT(*) FILTER (WHERE o.status = 'expired') AS missed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE o.status = 'accepted') / COUNT(o.id), 1) AS acceptance_rate_pct
FROM ride_offers o
JOIN driver_profiles d ON d.id = o.driver_profile_id
JOIN users u ON u.id = d.user_id
WHERE o.created_at > now() - interval '30 days'
GROUP BY d.id, u.full_name
HAVING COUNT(o.id) >= 5
ORDER BY acceptance_rate_pct DESC
LIMIT 30;
```

---

## §3 — Financial health

### Daily revenue + commission

```sql
SELECT
  DATE(completed_at) AS date,
  COUNT(*) AS rides_completed,
  SUM(final_fare_cup) AS gross_revenue_cup,
  SUM(final_fare_cup * commission_rate) AS commission_cup,
  SUM(final_fare_cup * (1 - commission_rate)) AS driver_earnings_cup
FROM rides r
JOIN ride_pricing_snapshots rps ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
WHERE completed_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;
```

### Wallet balance integrity check (debits = credits)

```sql
-- Per account, sum of ledger entries should equal balance
SELECT
  wa.id AS account_id,
  wa.account_type,
  u.full_name,
  wa.balance AS stored_balance,
  COALESCE(SUM(le.amount), 0) AS computed_balance,
  ABS(wa.balance - COALESCE(SUM(le.amount), 0)) AS drift
FROM wallet_accounts wa
LEFT JOIN ledger_entries le ON le.account_id = wa.id
JOIN users u ON u.id = wa.user_id
GROUP BY wa.id, wa.account_type, u.full_name, wa.balance
HAVING ABS(wa.balance - COALESCE(SUM(le.amount), 0)) > 0
ORDER BY drift DESC
LIMIT 20;
```

**Alert**: si returns rows → ledger desync, CRITICAL. Pause wallet operations + investigar.

### NETOPIA payment health

```sql
SELECT
  DATE(created_at) AS date,
  status,
  COUNT(*) AS count,
  SUM(amount_cup) AS total_cup,
  ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))) AS avg_seconds_to_complete
FROM payment_intents
WHERE provider = 'netopia'
  AND created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

**Alert**: si `status='failed'` >20% → NETOPIA degraded.

---

## §4 — Fraud detection

### Drivers con cancellation rate alta (>30%)

```sql
SELECT
  d.id AS driver_id,
  u.full_name,
  u.phone,
  COUNT(*) AS total_rides,
  COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'driver') AS driver_cancelled,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'driver') / COUNT(*), 1) AS cancel_rate_pct
FROM rides r
JOIN driver_profiles d ON d.id = r.driver_id
JOIN users u ON u.id = d.user_id
WHERE r.created_at > now() - interval '14 days'
GROUP BY d.id, u.full_name, u.phone
HAVING COUNT(*) >= 5
  AND COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'driver') > COUNT(*) * 0.3
ORDER BY cancel_rate_pct DESC;
```

### Rides con fare anómalo (><3x avg)

```sql
WITH stats AS (
  SELECT
    service_type,
    AVG(final_fare_cup) AS avg_fare,
    STDDEV(final_fare_cup) AS std_fare
  FROM rides
  WHERE status = 'completed' AND completed_at > now() - interval '30 days'
  GROUP BY service_type
)
SELECT
  r.id,
  r.created_at,
  r.service_type,
  r.final_fare_cup,
  s.avg_fare::int,
  ROUND((r.final_fare_cup - s.avg_fare) / NULLIF(s.std_fare, 0), 2) AS z_score
FROM rides r
JOIN stats s ON s.service_type = r.service_type
WHERE r.status = 'completed'
  AND r.completed_at > now() - interval '7 days'
  AND ABS(r.final_fare_cup - s.avg_fare) > 3 * s.std_fare
ORDER BY z_score DESC
LIMIT 20;
```

### Concurrent driver rides (debe ser 0 — UNIQUE INDEX prevent — alert si returns row)

```sql
SELECT * FROM diag_concurrent_driver_rides();
-- Si retorna rows → constraint rides_one_active_per_driver fue bypasseado (debería ser imposible)
```

---

## §5 — Performance

### Slow queries (top 10 last hour)

```sql
SELECT
  LEFT(query, 100) AS query_preview,
  calls,
  ROUND(total_exec_time::numeric, 0) AS total_ms,
  ROUND(mean_exec_time::numeric, 0) AS mean_ms,
  ROUND((total_exec_time / SUM(total_exec_time) OVER ())::numeric * 100, 1) AS pct_of_total
FROM pg_stat_statements
WHERE calls > 10
ORDER BY total_exec_time DESC
LIMIT 10;
```

### Table sizes (encontrar tablas que crecen)

```sql
SELECT
  schemaname,
  relname,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS size,
  pg_total_relation_size(schemaname || '.' || relname) AS bytes
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY bytes DESC
LIMIT 15;
```

### Edge Functions latency (via Sentry — example query)

(En Sentry Discover): `event.type:transaction transaction:"GET /functions/v1/*"` agrupar by `transaction`, p95.

**Targets**:
- `accept_ride_v2` < 200 ms p95
- `complete_ride_and_pay` < 500 ms p95
- `send-sms-otp` < 2 sec p95 (external D7 call)
- `search-places-google` < 1 sec p95 (external Google call)

---

## §6 — Concurrency check (run daily)

```sql
-- Should always return 0 rows. If >0, alarm.
SELECT * FROM diag_concurrent_driver_rides();
```

**Cron**: Si querés alertar automático, agregar pg_cron job que envíe email via `send-email` EF cuando query > 0.

---

## §7 — Cron job health

```sql
-- Últimos 20 runs de cualquier cron job + status
SELECT
  jrd.runid,
  j.jobname,
  jrd.start_time,
  jrd.end_time,
  EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::int AS duration_seconds,
  jrd.status,
  LEFT(jrd.return_message, 80) AS message_preview
FROM cron.job_run_details jrd
JOIN cron.job j ON jrd.jobid = j.jobid
ORDER BY jrd.start_time DESC
LIMIT 20;
```

**Alert**: si algún job status='failed' en últimos 3 runs → investigar.

---

## Dashboards externos

- **Sentry**: https://sentry.io/organizations/agencia-senores/projects/tricigo-mobile/
- **PostHog**: https://app.posthog.com/project/X (acceso vía PostHog dashboard)
- **Supabase**: https://supabase.com/dashboard/project/lqaufszburqvlslpcuac
- **NETOPIA**: dashboard partner (URL custom)

---

## Setup automation futuro

Para reducir queries manuales, considerar:
1. **Grafana** con Supabase Postgres como datasource — gráficos auto-refresh
2. **Cron jobs adicionales** que escriban summaries a `health_metrics_daily` table → fácil dashboard sin queries pesados
3. **PostHog dashboards** para business metrics (DAU, retention, funnel)

Out of scope para launch — agregar post-launch cuando hay >100 DAU.
