# Sentry Alerts Setup — TriciGo Production

> **Pre-requisito**: Sentry account activa con projects `tricigo-mobile-client` y `tricigo-mobile-driver` ya configurados.
> **Tiempo estimado**: 30 minutos para crear todas las alertas.
> **Audiencia**: founder + on-call engineer (recibe notificaciones).

---

## Filosofía: Alertar solo lo accionable

Cada alerta debe tener:
- **Threshold claro** (no "muchos errores", sino ">1% error rate en 5 min")
- **Acción definida** en runbook (`docs/DISASTER_RECOVERY.md`)
- **Severidad**: Critical (page on-call), Warning (email), Info (digest weekly)

Si una alerta no cumple las 3 → no la crees. Demasiadas alertas → fatigue → todos se ignoran.

---

## Alertas Critical (page inmediato)

### 1. Crash spike post-release

**Why**: nuevo release introduce crash. Hotfix vía OTA EAS update urgente.

**Sentry Alert Config**:
- Type: Issue alert
- Filter: `release:client@*` OR `release:driver@*`
- Condition: New issue with `level:fatal` created
- Action: Send Slack message to `#alerts-critical` + email founder

**Resolución**: ver `docs/DISASTER_RECOVERY.md` §6 Mobile app crash.

### 2. `complete_ride_and_pay` failure rate >1%

**Why**: payment processing crítico. Falla = revenue loss + customer disputes.

**Sentry Alert Config**:
- Type: Metric alert
- Metric: `count(transaction:"POST /functions/v1/complete_ride_and_pay" status:internal_error)`
- Condition: > 5 events in 5 min window
- Action: Page on-call (Slack + email + SMS if configurable)

**Resolución**: `DISASTER_RECOVERY.md` §2 (EF revert) + §4 (NETOPIA degraded).

### 3. NETOPIA webhook 5xx spike

**Why**: pagos no se completan, payment_intents quedan stuck.

**Sentry Alert Config**:
- Type: Metric alert
- Metric: `count(transaction:"POST /functions/v1/process-netopia-webhook" status_code:5XX)`
- Condition: > 3 events in 10 min
- Action: Page on-call + auto-create JIRA/Linear issue

**Resolución**: `DISASTER_RECOVERY.md` §4.

### 4. accept_ride_v2 success rate <80%

**Why**: drivers no pueden aceptar viajes → marketplace caído.

**Sentry Alert Config**:
- Type: Metric alert
- Metric: ratio `count(transaction:"POST /functions/v1/accept_ride_v2" status:ok) / count(transaction:"POST /functions/v1/accept_ride_v2")`
- Condition: < 0.80 over 15 min
- Action: Page on-call

---

## Alertas Warning (email, no page)

### 5. SMS OTP send failure rate >10%

**Sentry Alert Config**:
- Type: Metric alert
- Metric: `count(transaction:"POST /functions/v1/send-sms-otp" status:internal_error)`
- Condition: > 10 events in 1 hour
- Action: Email founder + Slack `#alerts-warning`

**Causa probable**: D7 credit empty, D7 service degraded, sender ID issue.

### 6. Push notification delivery dropoff

**Sentry Alert Config**:
- Type: Metric alert
- Metric: `count(message:"push delivery failed")`
- Condition: > 20 events in 30 min
- Action: Email founder

**Causa probable**: APNs cert expired, FCM key revoked, Expo down.

### 7. Slow query >5 sec

**Sentry Alert Config**:
- Type: Performance alert
- Metric: `p95(transaction.duration)` for transactions matching `db.query.*`
- Condition: > 5000 ms over 10 min
- Action: Email founder

**Resolución**: identificar query → agregar index o reescribir.

### 8. Edge Function cold start spike

**Sentry Alert Config**:
- Type: Performance alert
- Metric: `p95(transaction.duration)` for `transaction:"POST /functions/v1/*"`
- Condition: > 3000 ms over 10 min
- Action: Email

**Causa probable**: Supabase region pressure, EF code regression.

---

## Alertas Info (weekly digest)

### 9. Top 10 errors weekly

**Sentry Config**:
- Type: Weekly digest
- Send: Lunes 09:00 hora local
- Content: top 10 unresolved issues + new issues this week
- Action: Email founder

### 10. Performance trends

**Sentry Config**:
- Type: Weekly digest
- Content: p95 / p99 trends for top 10 transactions
- Action: Email founder

---

## Setup steps en Sentry

### Para cada alerta crítica:

1. Ir a https://sentry.io/organizations/agencia-senores/projects/tricigo-mobile-client/alerts/new/
2. Click "Create Alert" → seleccionar Type (Issue / Metric / Performance)
3. Configurar filter + condition según tabla arriba
4. Action: agregar
   - Slack integration: instalar plugin Sentry + Slack workspace
   - Email: ya por default
   - PagerDuty (opcional para SMS): integración custom
5. Save.

### Repetir para project `tricigo-mobile-driver`.

### Crear channel Slack `#alerts-critical` con miembros:
- Founder (Eduardo)
- On-call engineer rotation (1 por semana)

---

## Test de cada alert

Después de configurar, ejecutar test:

1. **Crash spike**: triggerear crash en preview build, verificar alert llega.
2. **EF failure**: forzar 500 en EF dev (manual deploy con `throw new Error()`), verificar alert.
3. **Slow query**: ejecutar query lenta a propósito, verificar alert.

Si alguna no dispara → revisar filter/condition.

---

## Mantenimiento

- **Mensual**: revisar `Sentry → Performance → Top transactions` para spot regressions.
- **Trimestral**: tunear thresholds basado en baseline real (ajustar si >10% false positives).
- **Anual**: pruning old issues + ajustar weekly digests.

---

## Alternativas si Sentry no alcanza

- **Better Stack** (Logtail + Better Uptime): logs + uptime monitoring + status page. ~$25/mes.
- **Grafana Cloud**: dashboards custom + alerts. Free tier suficiente para inicio.
- **Datadog**: enterprise-grade. $15/host/mes — caro para MVP.

Por ahora Sentry free tier (5k events/mes) suficiente. Upgrade a paid si volumen pasa 5k errores/mes.
