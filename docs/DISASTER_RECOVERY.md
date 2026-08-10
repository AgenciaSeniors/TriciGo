# Disaster Recovery Runbook — TriciGo Producción

> **Audiencia**: Founder + on-call engineer.
> **Objetivo**: restaurar servicio crítico (signup, ride flow, payments) en <2 horas tras incidente.
> **Pre-requisitos**: Supabase Pro tier (backups daily + PITR), acceso DNS, AWS/VPS console.

---

## Escenarios + RTO/RPO

| Escenario | Detection | RTO target | RPO target | Sección |
|---|---|---|---|---|
| DB corruption / accidental DROP | Pgaudit + Sentry | 60 min | 5 min (PITR) | §1 |
| Edge Function caída / regression | Sentry alerts + smoke test | 15 min | 0 (redeploy git) | §2 |
| Supabase region outage | StatusPage + monitoring | depende Supabase | n/a | §3 |
| Payment provider (NETOPIA) down | Webhook delays + user reports | n/a (passthrough) | n/a | §4 |
| Push notifications fail | PostHog drop in event | 30 min | n/a | §5 |
| Mobile app crash en producción | Sentry + Crashlytics + user reports | depende rebuild APK | n/a | §6 |
| DDoS / abuse | Supabase rate limit + WAF | 30 min | n/a | §7 |
| Secret leak (API key exposed en GitHub) | GitGuardian + manual review | 30 min | n/a | §8 |

---

## §1 — DB corruption / accidental DROP

**Síntomas**:
- Queries devuelven 0 rows donde antes había data
- `pg_class` muestra tabla missing
- App tira "relation does not exist"
- Sentry spike de errors

**Pasos**:

1. **Snapshot evidencia inmediato**:
   ```sql
   -- Capturar timestamp exacto del incidente
   SELECT now() AS incident_ts;
   -- Confirmar daño
   SELECT COUNT(*) FROM rides;  -- o tabla afectada
   ```

2. **Restaurar desde PITR (Point-In-Time Recovery)**:
   - Ir a https://supabase.com/dashboard/project/lqaufszburqvlslpcuac/database/backups
   - Click "Restore" → seleccionar timestamp ANTES del incidente (típicamente "5 min antes")
   - **WARNING**: PITR crea un NEW project — no sobrescribe el actual.
   - Una vez restaurado el new project, opciones:
     - **Migrar data del backup al actual** (preserva conexiones / app config):
       ```bash
       # Export from backup
       pg_dump -h <BACKUP_HOST> -U postgres -t affected_table > backup.sql
       # Import to current
       psql -h <CURRENT_HOST> -U postgres < backup.sql
       ```
     - **Cambiar app a apuntar al new project**: update `EXPO_PUBLIC_SUPABASE_URL` + redeploy. Mayor downtime pero más limpio si el daño es masivo.

3. **Validar restore**:
   ```sql
   SELECT COUNT(*) FROM rides WHERE created_at > now() - interval '7 days';
   ```

4. **Postmortem**: documentar causa (admin SQL ejecutó DROP? migration ran on prod accidentally? exploit?). Ajustar permisos para evitar repetición.

---

## §2 — Edge Function caída / regression

**Síntomas**:
- Sentry alert "Function X returning 5xx"
- Smoke test curl falla
- App muestra error específico de la EF

**Pasos**:

1. **Identificar EF afectada** (Sentry tag, logs):
   ```bash
   supabase functions list --project-ref lqaufszburqvlslpcuac
   ```

2. **Revertir al último deploy estable**:
   - Cada `supabase functions deploy <fn>` crea nueva version. Para revertir:
   ```bash
   # Ver versions
   gh api repos/AgenciaSeniors/TriciGo/actions/workflows/deploy-edge-functions.yml/runs --paginate --jq '.workflow_runs[0:5]'
   # Re-run workflow del commit anterior bueno
   gh workflow run deploy-edge-functions.yml --ref <COMMIT_HASH_PREVIO>
   ```

3. **Si no hay workflow auto-deploy** (deploy manual previo):
   ```bash
   git checkout <COMMIT_HASH_PREVIO>
   cd supabase/functions/<fn>
   supabase functions deploy <fn> --project-ref lqaufszburqvlslpcuac
   git checkout master
   ```

4. **Validar fix**:
   ```bash
   curl -X POST https://lqaufszburqvlslpcuac.supabase.co/functions/v1/<fn> \
     -H "Authorization: Bearer <ANON>" -d '{...test payload...}'
   ```

5. **Postmortem**: por qué pasó el regression a master. Agregar test si missing.

---

## §3 — Supabase region outage

**Síntomas**:
- Multiple EFs failing globally
- Supabase status page (https://status.supabase.com) muestra outage
- Dashboard inaccesible

**Pasos**:

1. **Verificar status**: https://status.supabase.com
2. **Comunicar a usuarios** via status page propio (`status.tricigo.com` — TODO si no creado):
   - Twitter / WhatsApp Business / push notif si todavía funcionan
3. **Esperar resolución Supabase** — no hay self-service para region outage.
4. **Mientras tanto**:
   - Mobile apps: muestran error "Servicio temporalmente no disponible. Reintenta en unos minutos."
   - Web: muestra mismo mensaje.
   - Cache stale (Mapbox tiles, local state) sigue working para usuarios ya logged.
5. **Post-recovery**:
   - Validar smoke test completo (signup, ride request, payment).
   - Comunicar via push "Servicio restaurado".

---

## §4 — NETOPIA payment provider down

**Síntomas**:
- Recarga wallet falla con timeout
- Webhook nunca llega → payment intents stuck en `pending`
- User reports "pagué pero no me llegó saldo"

**Pasos**:

1. **Verificar status NETOPIA**: contactar al partner manager (email/WhatsApp directo).
2. **Modo degradado**:
   - Disable wallet recharge button temporalmente (feature flag).
   - Cliente sigue pudiendo pagar viajes con saldo existente o efectivo al driver.
3. **Reconciliación manual post-recovery**:
   - Identificar `payment_intents` stuck:
     ```sql
     SELECT * FROM payment_intents
     WHERE status = 'pending' AND created_at < now() - interval '30 min'
     ORDER BY created_at;
     ```
   - Para cada uno: confirmar con NETOPIA via dashboard si transacción llegó.
   - Si sí pagó: `SELECT process_recharge_payment('<intent_id>'::uuid, ...);` manualmente.
   - Si no pagó: marcar `status='failed'`.

4. **Postmortem**: ¿NETOPIA tiene SLA? ¿Vale añadir Tropipay como segundo provider?

---

## §5 — Push notifications fail

**Síntomas**:
- Drivers no reciben offer pushes → cancellation rate spike
- PostHog event `push_received` drop a 0

**Pasos**:

1. **Verificar Expo Push status**: https://status.expo.dev
2. **Verificar APNs cert** (iOS):
   - Apple Developer Account → Certificates → Apple Push Notification Service
   - Si expired (1 año validity): renovar + re-upload a Expo Dashboard.
3. **Verificar FCM** (Android):
   - Firebase Console → Project Settings → Cloud Messaging → confirmar Server Key activa.
4. **Edge Function `send-push` logs**:
   ```bash
   supabase functions logs send-push --project-ref lqaufszburqvlslpcuac
   ```
5. **Manual fallback**: si push está down >1h, send SMS via D7 EF a driver con offer URL.

---

## §6 — Mobile app crash en producción

**Síntomas**:
- Sentry crash spike post-release
- Reviews 1-star "app se cierra"
- DAU drop

**Pasos**:

1. **Identificar release problemático** en Sentry:
   - Filter by release version (e.g. `client@1.0.0`)
   - Identificar stack trace común

2. **Hotfix express**:
   - Si el crash es JS-only: publica un OTA **por el workflow**, nunca desde tu
     máquina. GitHub → Actions → **"EAS Update (OTA)"** → Run workflow:
     `app` = client | driver · `message` = "Hotfix crash X" · `rollout_percentage` = 10.
     Los users reciben el fix sin re-install (segundos).

     > **Nunca `eas update` local.** Bundlea sin leer el `env` de `eas.json`, así
     > que inlinea un token Mapbox **vacío** y una URL de Supabase vacía, y eso
     > sale por aire a toda la flota: la app crashea al arrancar (el home del
     > conductor ES el mapa). El detalle está en el header de
     > `.github/workflows/eas-update.yml`.

     Para frenar: workflow **"EAS Update — ops"** → `pause` (el freno más rápido,
     no publica nada) o `rollback`. Si publicaste con un `rollout_percentage`
     menor a 100, ese rollout queda **abierto** y EAS rechaza el siguiente OTA
     del mismo app hasta que lo lleves a 100 (`promote`) o lo reviertas
     (`rollback`).
   - Si crash es nativo: requiere rebuild APK/IPA:
     ```bash
     eas build --profile production --platform all
     # Esperar 30-45 min
     eas submit --profile production --platform all
     # Apple TestFlight beta → expedited review (12-24h vs normal 1-3 días)
     ```

3. **Si necesita rollback completo**:
   - Apple: ir a App Store Connect → version 1.0.0 → "Reject this version" + re-submit 0.9.X
   - Google Play: Production track → Rollback to previous release

---

## §7 — DDoS / abuse

**Síntomas**:
- Supabase RDS metrics CPU 100%
- Edge Functions timeout
- Bills spike (Stripe / NETOPIA)

**Pasos**:

1. **Identificar pattern**:
   ```sql
   -- Top callers en rpc_attempt_log últimas 1h
   SELECT caller_uid, COUNT(*) FROM rpc_attempt_log
   WHERE created_at > now() - interval '1 hour'
   GROUP BY caller_uid
   ORDER BY 2 DESC
   LIMIT 20;
   ```

2. **Block abusers**:
   ```sql
   -- Suspender user
   UPDATE users SET is_active = false WHERE id = '<abuser_uid>';
   -- O bloquear IP via Supabase Auth settings (Dashboard)
   ```

3. **Activar Cloudflare** (si no en uso): proxy DNS via Cloudflare proteg al endpoint.
4. **Supabase rate limiting**: subir a Pro tier si no estás (5x más capacity).

---

## §8 — Secret leak en GitHub

**Síntomas**:
- GitGuardian email "Secret detected"
- Sentry traces muestran 401 unauthorized de provider externo (key rotada por provider)

**Pasos**:

1. **Identificar secret** y dónde quedó expuesto:
   ```bash
   git log -S "<KEY_VALUE>" --all
   ```

2. **Rotar inmediatamente**:
   - NETOPIA: dashboard → API keys → regenerate
   - D7 Networks: dashboard → API keys → revoke + new
   - Mapbox: account → access tokens → restrict + new
   - Stripe: dashboard → API keys → roll
   - Supabase: dashboard → API → regenerate anon key (CUIDADO: tiene cascade impact)

3. **Setear nuevo secret**:
   - Supabase EF: `supabase secrets set NEW_KEY=xxx`
   - GitHub Actions: Settings → Secrets → update
   - EAS env: `eas env:create --scope project --visibility secret`
   - Mobile apps: rebuild APK con new key, OTA si JS-only.

4. **Purge git history** (solo si secret está en histórico, no en current):
   ```bash
   git filter-repo --replace-text <(echo "OLD_SECRET==>REDACTED")
   git push origin master --force  # CUIDADO: comunicar a todo el equipo
   ```
   **Alternativa más segura**: si la rotación pasó, el secret en git history ya es inútil. Skip purge.

5. **Postmortem**: cómo entró el secret a git. Agregar pre-commit hook (`detect-secrets`) si missing.

---

## Contactos emergencia

| Servicio | Contact | SLA |
|---|---|---|
| Supabase | support@supabase.com (Pro tier email) + dashboard chat | 24-48h |
| NETOPIA | (manager directo del partner) | N/A — no formal SLA |
| D7 Networks | support@d7networks.com | 24h business days |
| Apple Developer | https://developer.apple.com/contact/topic/select | varies |
| Google Play | Play Console → Help & support | 24-48h |
| Expo | https://expo.dev/support | community + paid |

---

## Checklist post-incident

- [ ] Servicio core restaurado (signup, ride request, complete, payment)
- [ ] Sentry alert resolved
- [ ] PostHog metrics back to baseline
- [ ] Users notificados (si downtime >5 min usuarios visible)
- [ ] Postmortem doc creado en `docs/incidents/YYYY-MM-DD_<short_name>.md` con:
  - Timeline (detection → mitigation → resolution)
  - Root cause
  - Action items para evitar recurrencia
  - Communication record
- [ ] Action items asignados con dueño + deadline
- [ ] Doc actualizado si proceso de DR mejoró

---

## Backup strategy (Supabase Pro)

- **Daily backups** automáticos, 7 días retention (Pro tier)
- **PITR** (Point-In-Time Recovery): granularity 5 minutos
- **Manual snapshot** antes de operación riesgosa:
  ```bash
  # Solicitar manual backup via Supabase support
  ```

**Validar primer backup**: 24h post-upgrade a Pro, ir a Dashboard → Database → Backups y confirmar daily backup ran successfully.

---

## Práctica de DR

Cuatro veces al año (cada trimestre), ejecutar **fire drill**:
1. Pick un escenario random de la tabla §0
2. Asumir que pasó → ejecutar runbook
3. Medir tiempo total → comparar con RTO target
4. Documentar lo que salió mal + mejorar runbook

Recordatorio en Google Calendar: 2026-08-28, 2026-11-28, 2027-02-28, 2027-05-28.
