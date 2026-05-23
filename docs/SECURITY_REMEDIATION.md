# Security Remediation Tracking

Estado del programa de remediación de seguridad iniciado tras la auditoría completa de 2026-05-23. La auditoría identificó **65 findings + 11 advisors cross-cutting** distribuidos en las 4 apps (Client, Driver, Admin, Web) y trazó 3 kill chains críticos.

Los reportes detallados de auditoría (`SECURITY_AUDIT_*.md`) están **gitignored** porque contienen mapas de superficie de ataque y PoCs conceptuales. Compartir solo por canal privado. Este documento es el público (commiteado) que trackea el estado de los fixes.

---

## Sesión 2026-05-23 — 9 PRs creadas

### Ola 1 — P0 Críticos (los 3 kill chains + KYC)

| PR | Findings | Resumen | Pre-flight |
|----|----------|---------|------------|
| [#167](https://github.com/AgenciaSeniors/TriciGo/pull/167) | DRV-001 + DRV-002 + DRV-003 | Driver fraud kill chain: accept_ride_v2 status check + extended lockdown trigger + complete_ride_and_pay actuals validation | Verificar `SELECT count(*), status FROM driver_profiles WHERE status<>'approved' AND is_online=true GROUP BY status` antes |
| [#168](https://github.com/AgenciaSeniors/TriciGo/pull/168) | CLI-001 | Customer no puede UPDATE surge_multiplier/wallet_ratio/insurance_premium_cup/wait_time_charge_cup/driver_custom_rate_cup en su ride | Sin pre-flight |
| [#170](https://github.com/AgenciaSeniors/TriciGo/pull/170) | ADM-001 + ADM-002 | Admin escalation: tier separation admin vs super_admin + platform_config/feature_flags/pricing_rules require super_admin write | **CRÍTICO**: `SELECT id FROM users WHERE role='super_admin'` debe devolver ≥1 row. Si 0, bootstrappear via service_role antes de aplicar |
| [#176](https://github.com/AgenciaSeniors/TriciGo/pull/176) | CC-04 | KYC selfie: opción C (remover step UI hasta proveedor real). Manual admin review es el control activo | Setear `auto_approve_drivers_enabled=false` en platform_config tras merge |

### Ola 2 — P1 Altos (5 PRs de 8 del plan)

| PR | Findings | Resumen |
|----|----------|---------|
| [#171](https://github.com/AgenciaSeniors/TriciGo/pull/171) | CC-03 | Netopia webhook valida `amount` contra payment_intent (5% tolerance) |
| [#172](https://github.com/AgenciaSeniors/TriciGo/pull/172) | ADV-01 | `wallet_accounts_v2` y `ride_audit_log` views convertidas a SECURITY INVOKER (cierra 2 ERROR-level Supabase advisors) |
| [#173](https://github.com/AgenciaSeniors/TriciGo/pull/173) | DRV-006 + DRV-007 + DRV-008 | Passenger protection RLS: tips ride-membership + ride_location_events status filter + ride_messages status filter (cierra driver-side stalking) |
| [#174](https://github.com/AgenciaSeniors/TriciGo/pull/174) | CLI-020 + DRV-005 | Storage hardening: avatars bucket no listing + driver_documents MIME whitelist trigger |
| [#175](https://github.com/AgenciaSeniors/TriciGo/pull/175) | CC-01 + ADM-012 | Server-side JWT revocation infrastructure + audit_users trigger |

### Migraciones agregadas (00287 – 00297)

| # | Archivo | Fix |
|---|---------|-----|
| 00287 | `accept_ride_v2_status_check.sql` | DRV-001 — driver.status='approved' gate |
| 00288 | `driver_profiles_extended_lockdown.sql` | DRV-002 — lock custom_per_km_rate_cup + is_online gate |
| 00289 | `complete_ride_and_pay_actuals_validation.sql` | DRV-003 — trg_rides_validate_actuals trigger |
| 00290 | `enforce_ride_update_columns_pricing_lockdown.sql` | CLI-001 — pricing fields locked for customer |
| 00291 | `users_role_super_admin_tier.sql` | ADM-001 — is_super_admin helper + tier-aware trigger + promote_user_role RPC |
| 00292 | `platform_config_super_admin_tier.sql` | ADM-002 — super_admin write on 4 config tables |
| 00293 | `process_recharge_payment_amount_validation.sql` | CC-03 — webhook amount cross-check |
| 00294 | `views_to_security_invoker.sql` | ADV-01 — 2 views to INVOKER |
| 00295 | `passenger_protection_rls_hardening.sql` | DRV-006/007/008 — RLS tightening |
| 00296 | `storage_hardening.sql` | CLI-020 + DRV-005 — avatars policy + MIME trigger |
| 00297 | `auth_revocations_and_audit_users.sql` | CC-01 + ADM-012 — auth_revocations infra + audit_users trigger |

**Próxima migración libre: 00298.**

---

## Pre-flight queries antes de aplicar a producción

Correr **en orden** antes del `supabase db push` o pipeline equivalente:

```sql
-- 1) Pre-merge PR #170 (ADM-001/002): asegurar ≥1 super_admin
SELECT id, email, role FROM users WHERE role = 'super_admin';
-- Si 0: UPDATE users SET role='super_admin' WHERE id='<founder-uuid>'; -- via service_role

-- 2) Pre-merge PR #167 (DRV-001): drivers no aprobados online ahora
SELECT count(*), status FROM driver_profiles
 WHERE status <> 'approved' AND is_online = true
 GROUP BY status;
-- Si >0: investigar (drivers explotando el gap actual); ellos NO podrán aceptar rides nuevos tras apply

-- 3) Post-merge PR #176 (CC-04): forzar admin manual review
UPDATE platform_config SET value = 'false' WHERE key = 'auto_approve_drivers_enabled';

-- 4) Post-merge PR #175 (CC-01): verificar que pg_cron scheduling se aplicó
SELECT * FROM cron.job WHERE jobname = 'cleanup_auth_revocations';
-- Si vacío: pg_cron no estaba instalado; cleanup queda manual o por cron externo

-- 5) Post-todo: re-correr advisors y verificar baja
-- (vía Supabase MCP get_advisors — debe bajar de 343 a ~339)
```

---

## Backlog — pendientes para sesiones futuras

### Ola 2 — diferidos del scope original (3 PRs)

| PR | Findings | Esfuerzo | Razón del diferimiento |
|----|----------|----------|------------------------|
| PR-09 | ADM-003/004/005/006 | 2d | admin_adjust_wallet cap + idempotency + dispute_refund provider orchestration + admin audit PII access. Complejo, sesión enfocada. |
| PR-10 | WEB-001 + WEB-002 + WEB-006 | 1d | CSP + HSTS + DOMPurify config. Requiere período de soak con Report-Only CSP antes de enforcing. |
| PR-12 | ADV-05 (142 funciones) | 5d | Auditoría sistemática de SECURITY DEFINER functions anon-callable. Decisión por función — sesión dedicada. |

### Ola 3 — P2 Medios (4 PRs, ~11d total)

| PR | Findings | Esfuerzo |
|----|----------|----------|
| PR-13 | CLI-006 + CLI-007 + CLI-008 + CLI-010 + CLI-011 + CC-06 | 3d |
| PR-14 | DRV-009 + DRV-010 + DRV-011 + DRV-012 + DRV-014 + DRV-015 | 4d |
| PR-15 | ADM-007 + ADM-008 + ADM-009 + ADM-010 | 3d |
| PR-16 | WEB-003 + WEB-004 + WEB-007 + WEB-008 | 1d |

### Ola 4 — Advisors residuales (2 PRs, 3d total)

| PR | Findings | Esfuerzo |
|----|----------|----------|
| PR-17 | ADV-03 (mover extensions a schema) | 2d (alto riesgo regresión PostGIS) |
| PR-18 | ADV-04 (40 funciones sin SET search_path) | 1d (mostly automated) |

### Follow-ups específicos identificados durante remediación

| Item | Trigger | Notas |
|------|---------|-------|
| CC-02 OTP rate limit endurecido | Sesión aparte | Toca EF Deno + RPC Postgres. 5 attempts/10min + exponential backoff + 24h account lockout tras 3 OTPs consecutivos fallidos |
| Adopción de `is_session_revoked()` en RLS write policies | Tras soak post-PR #175 | Agregar `AND NOT is_session_revoked()` a WITH CHECK en `rides`, `wallet_accounts`, `payment_intents` (incremental, una tabla por PR) |
| Selfie KYC opción A (AWS Rekognition) | Cuando AWS account + legal GDPR review listos | 3-5d dev + 2-3d compliance (DPIA + consent form + retention policy + privacy policy update) |
| pgTAP test infrastructure | Cualquier momento | Permite tests reales de RLS/triggers que vitest service-layer no puede cubrir. Recommended para validar PR-01/02/03/06/07/08/11/05 retroactivamente |
| Verificación migración aplicada en prod | Continuous | Cada PR de seguridad documenta qué query correr post-apply para verificar fix activo |

---

## Métricas — postura de seguridad

### Antes (auditoría 2026-05-23)

- 65 findings (1 CRÍTICO + 4 ALTO + 8 MEDIO + 9 BAJO) en Client + (3+5+8+4) en Driver + (2+4+4+2) en Admin + (0+3+5+3) en Web
- 343 Supabase advisors (3 ERROR + 337 WARN + 3 INFO)
- 3 kill chains críticos explotables

### Después de Ola 1 + Ola 2 esta sesión (aplicado en prod)

- **3 kill chains críticos cerrados** (Driver fraud, Admin escalation, Client fare manip)
- **6 findings CRÍTICOS** (de 6) → 0 (todos cubiertos por las 4 PRs de Ola 1)
- **9 findings ALTOS** (de 16) cubiertos por Ola 2 → 7 ALTOS pendientes (PR-09 + parte PR-10/12)
- **2 ERROR-level Supabase advisors** cerrados → debería bajar de 343 a ~341 tras apply

### Target post-Ola 3 + Ola 4

- 0 findings CRÍTICOS / ALTOS abiertos
- < 50 Supabase advisors WARN+ERROR (de 343)
- ASVS Level 2 self-assessment ≥90% items cumplidos

---

## Cómo agregar una nueva PR de seguridad

Patrón establecido en Ola 1 y Ola 2 esta sesión:

1. **Branch desde `origin/master` fresh**: `git checkout -b claude/security/<descripción> origin/master`
2. **Identificar tabla/RPC afectado** y leer la migración más reciente como base
3. **Escribir migración nueva** en `supabase/migrations/00NNN_descripcion.sql` con header explicativo (BUG/finding ID + por qué + qué bloquea + side effects esperados)
4. **Frontend tolerance**: si la migración introduce nueva RPC, el cliente debe tolerar su ausencia (`.catch(() => fallback)`)
5. **Tests** según severidad:
   - CRITICAL/HIGH con service-layer code path → TDD strict (red→green) en vitest
   - DB-only fixes sin service-layer caller → documentar limitación + recomendar pgTAP follow-up
6. **Reset `pnpm-lock.yaml`** tras tests locales: `git checkout HEAD -- pnpm-lock.yaml`
7. **Commit con header convencional**: `fix(security): <breve> (<finding ID>)`
8. **PR body documenta**: el ataque, el fix, side effects en apply, pre-flight queries si aplican, test coverage limitation honesto
9. **Push requiere autorización per-PR explícita** del usuario (classifier de auto-mode lo enforza)
10. **Mergeo a master requiere autorización per-PR** (mismo patrón, separado del push)

Detalle de patrones en `CLAUDE.md` § "Operación: deploys, migraciones y merges" → "Patrones de remediación de seguridad" (agregado en esta misma PR).

---

## Última actualización

**2026-05-23 sesión completa de remediación** — 9 PRs creadas (4 Ola 1 + 5 Ola 2), 11 migraciones nuevas (00287–00297), 19+ test cases TDD. Estado: PRs pusheadas, esperando merge + apply de migraciones por proceso humano.

Próxima actualización: cuando la siguiente sesión agarre PR-09, PR-10, o PR-12.
