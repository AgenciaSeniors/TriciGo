# Data Retention Policy

> **Estado**: Activo desde migración `00342_data_retention_policy.sql` (2026-05-28).
> **Audiencia**: Compliance, soporte usuarios (GDPR requests), DBA monitoring.
> **Auditoría**: `cron.job_run_details` muestra runs históricos.

---

## Resumen ejecutivo

| Tabla | Política | Frecuencia | Threshold | Acción |
|---|---|---|---|---|
| `ride_location_events` | Hard delete | Daily 03:30 UTC | >90 días | DELETE (sin recover) |
| `rides` (completed/cancelled/expired) | Anonymize PII | Weekly Sunday 04:00 UTC | >730 días | UPDATE customer_id/driver_id NULL, addresses → 'ANONYMIZED' |
| `rpc_attempt_log` | Hard delete | Daily 03:17 UTC | >90 días | DELETE (pre-existing job `prune-rpc-attempt-log`) |
| `otp_codes` | Hard delete | Hourly | >2 horas tras `expires_at` | DELETE (pre-existing job `cleanup-expired-otp-codes`) |
| `auth_revocations` | Hard delete | Daily 03:00 UTC | Vencidas | DELETE (pre-existing `cleanup_auth_revocations`) |
| `notifications` | Hard delete | Daily 03:00 UTC | (defined in `cleanup_old_notifications`) | DELETE |

---

## Detalle por tabla

### 1. `ride_location_events` — GPS pings de driver durante rides

**¿Por qué se purga?**
- 1 ping cada ~5 segundos por ride activo en `in_progress`.
- A escala (1000 rides/día × 30 min avg × 12 pings/min) = ~360k filas/día = ~130M/año.
- Sin purge, satura disk + degrada query performance del histórico.

**¿Qué se preserva?**
- Distancia + duración real del ride (snapshot en `rides.actual_distance_m` / `actual_duration_s` ya guardado al `complete_ride_and_pay`).
- Heatmaps demand: agregados en `hourly_demand_cells` materialized view (refresh hourly).

**Frecuencia**: cron job `prune-ride-locations-90d` corre diariamente a las 03:30 UTC.

**Función**: `public.prune_old_ride_location_events()` — retorna `{deleted_rows, oldest_kept, ran_at}`.

**Ejecutar manualmente**:
```sql
SELECT public.prune_old_ride_location_events();
```

---

### 2. `rides` — GDPR anonymization de rides viejos

**¿Por qué anonimiza en vez de borrar?**
- Compliance GDPR: cliente tiene "right to be forgotten" — pero TriciGo debe preservar accounting trail (revenue, fares cobrados) para auditoría fiscal/legal.
- Solución: borrar PII (vinculación al usuario) pero mantener el row con datos no-identificables.

**Campos anonimizados** (UPDATE):
- `customer_id` → `NULL`
- `driver_id` → `NULL`
- `pickup_address` → `'ANONYMIZED'`
- `dropoff_address` → `'ANONYMIZED'`
- `special_instructions` → `NULL`
- `cancel_reason` → `NULL`
- `share_token` → `NULL`

**Campos preservados** (para analytics/accounting):
- `id`, `status`, `service_type`, `created_at`, `completed_at`
- `actual_distance_m`, `actual_duration_s`, `final_fare_cup`
- `surge_multiplier`, `payment_method`, `commission_rate`
- `pickup_location`, `dropoff_location` (geo agregado, ya no linkable a usuario sin context)

**Threshold**: 730 días (~2 años) tras `created_at`. Solo rides en estados terminales (`completed`, `cancelled`, `expired`).

**Frecuencia**: weekly Sunday 04:00 UTC (`anonymize-old-rides-yearly`). Dataset crece lento — weekly suficiente.

**Idempotencia**: skips rows ya anonimizados (chequeando `customer_id IS NOT NULL OR pickup_address <> 'ANONYMIZED'`).

**Ejecutar manualmente** (e.g. GDPR delete request):
```sql
-- Para anonimizar un user específico ANTES del threshold (a pedido):
UPDATE rides SET
  customer_id = NULL,
  pickup_address = 'ANONYMIZED',
  dropoff_address = 'ANONYMIZED',
  special_instructions = NULL,
  share_token = NULL
WHERE customer_id = '<UUID_DEL_USER>';

-- También el usuario debe pasar por:
SELECT public.delete_user_account('<UUID_DEL_USER>');  -- existe en EF
```

---

### 3. Otras retentions (pre-existentes)

#### `rpc_attempt_log` (>90 días)
- Audit log para RPCs sensibles (accept_ride, complete_ride, etc.)
- Job: `prune-rpc-attempt-log` (jobid 15)
- Pre-existente desde migración previa.

#### `otp_codes` (>2h tras `expires_at`)
- OTPs SMS son single-use + 5-min TTL. Mantener 2h extra para debugging.
- Job: `cleanup-expired-otp-codes` (jobid 8)

#### `auth_revocations`
- Tokens revoked / JWT blocklist post-rotation.
- Job: `cleanup_auth_revocations` (jobid 28)

#### `notifications`
- Push notif log + in-app notification bell.
- Job: `cleanup-old-notifications` (jobid 29)

---

## Monitoreo de retention jobs

```sql
-- Últimos 10 runs de cualquier job
SELECT
  jrd.runid,
  j.jobname,
  jrd.start_time,
  jrd.end_time,
  jrd.status,
  LEFT(jrd.return_message, 100) AS return_message
FROM cron.job_run_details jrd
JOIN cron.job j ON jrd.jobid = j.jobid
WHERE j.jobname IN ('prune-ride-locations-90d', 'anonymize-old-rides-yearly', 'prune-rpc-attempt-log')
ORDER BY jrd.start_time DESC
LIMIT 10;
```

**Alert**: si un job tiene `status='failed'` en sus últimos 3 runs, escalar.

---

## Cumplimiento GDPR / privacy regulations

- **Right to access** (Art. 15): usuario puede pedir export de sus datos via `delete-account` EF preview, o admin pull desde `users` table + linkable joins.
- **Right to be forgotten** (Art. 17): manual UPDATE + `delete-user-account` EF para rides ANTES de 730 días threshold. Después de 730 días, anonymization automática cumple.
- **Data minimization** (Art. 5.1.c): solo se conservan campos esenciales para accounting/analytics.
- **Storage limitation** (Art. 5.1.e): retentions documentadas con thresholds claros.

**Política pública**: incluir en https://tricigo.com/privacy section "Cuánto tiempo guardamos tus datos".

---

## Cambios futuros

Para modificar threshold o agregar nueva retention:
1. Crear migration `00XYZ_retention_<purpose>.sql`
2. Update este doc + commit
3. PR review + apply

Si dataset crece muy rápido (e.g. >1M location events/día), considerar **table partitioning** por mes — `ride_location_events_2026_06`, etc. Migration scope grande, deferred hasta señal de pressure.
