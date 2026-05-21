# CASHOUT_REMOVAL_PLAN — Eliminación del sistema de redención del conductor

> **Fase 1 (Discovery) — completada.** Este plan inventaría el sistema de cashout del conductor y propone su eliminación para que el TriciCoin del conductor sea verdaderamente closed-loop.
> **NO se ejecutó ningún cambio.** Las Fases 2-4 esperan tu confirmación explícita de este plan.
> Fecha: 2026-05-18

## 0. Resumen — dos cosas distintas con el mismo nombre

- **(A) La FEATURE de redención** — la tabla `wallet_redemptions`, el RPC `approve_redemption`, el enum `redemption_status`, la UI de aprobación del admin y la auto-aprobación del `auto-admin`. **Esto es lo que se elimina.**
- **(B) El tipo `redemption` del enum `ledger_entry_type`** — aparece en transacciones históricas del libro mayor. **Esto se CONSERVA**: las redenciones pasadas siguen en el ledger y deben poder mostrarse. Quitar un valor de un enum de Postgres usado por filas históricas es destructivo. Misma lógica que se aplicó a `transfer_*` en el Sprint 1.

## 1. Inventario completo

### 1.1 Base de datos (`supabase/migrations/`)
| Archivo | Qué contiene |
|---|---|
| `00001_initial_schema.sql` | `CREATE TABLE wallet_redemptions` (l.210); `CREATE TYPE redemption_status` (l.29); `redemption` dentro de `ledger_entry_type` (l.21); RLS `wr_select`/`wr_insert`/`wr_admin` (l.526, 578-580) |
| `00003_wallet_dashboard_rpcs.sql` | RPC `get_wallet_dashboard` cuenta `pending_redemptions_count`/`_amount` desde `wallet_redemptions` (l.74-88) — **dependencia** |
| `00061_auto_admin_config.sql` | config `auto_approve_redemptions_enabled`/`_max_trc` (l.7-8); columna `redemptions_approved` (l.21) |
| `00094_trc_rebase_and_driver_quota.sql` | `UPDATE wallet_redemptions` — rebase de unidades (l.85-86) |
| `00189_wallet_redemption_atomic_approve.sql` | RPC `approve_redemption` (debita al conductor, ledger "Cashout approved"); CHECK `wallet_redemptions_amount_positive` |
| `00192_users_role_lockdown.sql` | grants / role-lockdown de `approve_redemption` |
| `00198_fix_cron_auto_admin...` | cron del `auto-admin` (incluye redenciones) |
| `00201_add_missing_fk_indexes.sql` | índices `idx_wallet_redemptions_driver_id` / `_transaction_id` |
| `00220`, `00242` | referencias menores |

> Las migraciones viejas NO se editan. La eliminación se hace con una **migración nueva** (`00XXX_remove_driver_cashout.sql`).

### 1.2 Backend / Edge functions
- `supabase/functions/auto-admin/index.ts` — `autoApproveRedemptions()` (l.77-91): auto-aprueba redenciones ≤ umbral; llama `approve_redemption`; reporta `redemptions_approved`.

### 1.3 API (`packages/api`)
- `src/services/admin.service.ts` — `getPendingRedemptions()` (l.1248) y `processRedemption()` (l.1275). Aprobado → RPC `approve_redemption`; rechazado → update de status. (l.1256 tiene un TODO viejo.)
- `src/services/__tests__/admin.test.ts` — tests de estos métodos.

### 1.4 Tipos (`packages/types`)
- `src/wallet.ts:84` — `interface WalletRedemption`.
- `src/enums.ts` — `redemption` dentro de `LedgerEntryType` → **CONSERVAR** (ver §0-B).

### 1.5 UI Admin (`apps/admin`)
- `src/app/wallet/page.tsx` — pestaña "Retiros pendientes", diálogos aprobar/rechazar, KPI de pendientes.
- `src/app/settings/automation/page.tsx` — toggle de auto-aprobación de retiros.
- `src/app/reports/page.tsx`, `src/app/audit/page.tsx` — labels de retiro.

### 1.6 UI Conductor / Cliente — solo DISPLAY (conservar)
- `apps/driver/app/wallet/index.tsx:125` y `apps/driver/src/components/earnings/RecentActivitySection.tsx:45` — mapeo de ícono para el tipo `redemption`.
- `apps/client/app/(tabs)/wallet.tsx`, `apps/web/src/app/wallet/page.tsx` — `redemption` en filtros de transacciones. `packages/utils/src/historyExport.ts` — label CSV.
- Conservan el soporte para mostrar transacciones `redemption` históricas del ledger.

### 1.7 i18n
- `{es,en,pt}/admin.json` — bloque de retiros (tab_redemptions, approve/reject, KPI, auto-aprobación).
- `{es,en,pt}/driver.json` — `tx_redemption` ("Retiro"/"Withdrawal"). **Conservar** como label de transacción histórica (opcionalmente renombrar a neutro).

### 1.8 Documentación
- `docs/ADMIN_GAPS.md`, `docs/AUDITORIA_BUGS.md`, `AUDITORIA_BUGS.md`, `docs/STORE_RELEASE.md`, `BUSINESS_MODEL.md` (§3, §5, §11 — a actualizar en Fase 4).

## 2. Hallazgo importante de discovery

**No existe UI en la app del conductor para SOLICITAR una redención.** La RLS `wr_insert` permite al conductor insertar en `wallet_redemptions`, pero no se encontró ningún código (`.insert` ni método de servicio) que cree una redención. Las redenciones se *aprueban* (admin + auto-admin) pero el punto de *creación* no está en el código de las apps.

→ **[REVISIÓN HUMANA]:** confirmar cómo se crean hoy las redenciones (¿manualmente en la DB? ¿flujo viejo? ¿soporte?). Determina si hay un punto de entrada adicional que eliminar.

## 3. Dependencias (qué se rompe si se toca)

- **`get_wallet_dashboard` RPC** (00003) hace `SELECT FROM wallet_redemptions`. Si la tabla se DROPea, el RPC falla y el dashboard admin `/wallet` deja de cargar → la migración nueva debe **también actualizar `get_wallet_dashboard`** para que no consulte la tabla.
- **`auto-admin`** llama `approve_redemption` y lee la tabla → hay que quitar `autoApproveRedemptions()` del edge function.
- **`admin.service.ts`** `getPendingRedemptions`/`processRedemption` consumen tabla y RPC → se quitan junto con la UI admin que los llama.
- **`approve_redemption` / `redemption_status`** — sin la tabla, sobran.
- El valor `redemption` de `ledger_entry_type` lo consumen filtros de display en 4 wallets → **no tocar**.

## 4. Datos vivos — [REQUIERE INPUT DEL EQUIPO]

**No consulté la base de datos de producción.** Antes de la Fase 2, el equipo debe obtener (del panel admin `/wallet`, que muestra el conteo de "Retiros pendientes", o con un `SELECT`):
- Nº total de filas en `wallet_redemptions`.
- Nº con `status = 'requested'` (pendientes — **dinero que conductores pidieron retirar**).
- Nº con `status IN ('approved','processed')` (históricas).

Sin este dato la Fase 2 no se puede ejecutar con seguridad.

## 5. Plan de migración de las redenciones pendientes

Las redenciones `requested` son solicitudes reales de conductores. **No se descartan.** Antes de eliminar el sistema:

1. **Backup:** exportar `wallet_redemptions` completa a JSON (`wallet_redemptions_backup_2026-05-18.json`).
2. **Resolver las pendientes — lo hace el equipo, no Claude:** cada redención `requested` se (a) aprueba y paga según el proceso actual, o (b) rechaza formalmente comunicando al conductor el cambio de modelo. Es una operación financiera y de relación con el conductor — la decide y ejecuta el fundador/admin. **Yo no ejecuto pagos.**
3. Recién con **cero redenciones en estado `requested`** se procede a la Fase 2.

> Decisión de negocio anotada: a los conductores que tenían saldo con expectativa de retiro hay que comunicarles el cambio. Excede a este plan técnico, pero no debe pasarse por alto.

## 6. Plan de rollback

- **Código:** cada fase commiteada por separado → rollback = `git revert` de los commits.
- **DB:** la migración nueva se entrega como **archivo** (`supabase/migrations/00XXX_...`); no se aplica automáticamente (guard de MCP / pipeline). Si se sigue la recomendación de §7 (deprecar, no DROP), el rollback de DB es trivial y no se pierde historial.
- **Backup:** el JSON del paso 5.1 permite reconstruir la tabla si hiciera falta.

## 7. Recomendación: deprecar + bloquear, NO hacer DROP

`wallet_redemptions` contiene **registros financieros históricos** (cashouts pasados, con `transaction_id` ligado al ledger). DROPear la tabla destruye ese rastro de auditoría — lo contrario de la postura de compliance que se busca.

**Recomendado:** la migración nueva (a) revoca la RLS `wr_insert` — nadie crea redenciones nuevas; (b) elimina el RPC `approve_redemption` y la config de auto-aprobación; (c) deja la tabla como registro histórico de solo lectura. Resultado: la **feature** queda muerta, el **historial** se preserva.

Alternativa (DROP total): posible pero **[REVISIÓN HUMANA]** — solo si el equipo confirma que no necesita el historial de cashouts para auditoría.

## 8. Cambios de UX necesarios (detalle para Fase 3)

- **App del conductor:** reencuadrar la semántica del saldo → "crédito de comisión" / "se usa para pagar comisiones de plataforma, no es retirable". Quitar referencias a "retirar/cobrar". (No hay botón de retiro que quitar — no existe; ver §2.)
- **Panel admin:** quitar la pestaña "Retiros pendientes" de `/wallet`, el KPI de pendientes y el toggle de auto-aprobación en `settings/automation`.
- **Display histórico:** la transacción `redemption` ("Retiro") sigue mostrándose para movimientos viejos del ledger; el label puede renombrarse a algo neutro pero no quitarse.

## 9. Otra inconsistencia con BUSINESS_MODEL.md (anotada, NO se arregla acá)

`BUSINESS_MODEL.md` §5 dice que TriciCoin es "no reembolsable… no se devuelve al cierre de cuenta". La página `/refunds` (creada en el Sprint 2 de la remediación previa) dice que el saldo no consumido **sí** es reembolsable al cierre de cuenta. La Fase 4 de esta tarea contempla actualizar `/refunds` — queda anotado para no perderlo.

## 10. Nota honesta de alcance

Completar las Fases 2-3 hace que el TriciCoin del conductor sea **genuinamente no convertible a dinero** — una mejora real y verificable hacia el modelo closed-loop. Pero esto **no resuelve ni toca** la pregunta de sanciones/OFAC del flujo de fondos: ese sigue siendo un tema legal independiente. "Closed-loop" será cierto a nivel del TriciCoin del conductor cuando el código lo refleje (post-Fase 2/3) — no antes, y no más allá de eso.

---

## Próximo paso

**Fase 1 completa — esperando tu confirmación de este plan.** Al aprobarlo, ejecuto la Fase 2, empezando por (a) confirmar que las redenciones `requested` están en cero (§4-5) y (b) el backup a JSON. Decisiones que conviene que confirmes antes: **deprecar vs DROP** (§7) y el manejo de las pendientes (§5).
