# CASHOUT_REMOVAL_LOG — Eliminación del sistema de cashout del conductor

> Log cronológico de la ejecución del plan `CASHOUT_REMOVAL_PLAN.md`.
> Cambio de modelo: el TriciCoin del conductor deja de ser convertible a dinero.
> Pasa a ser un crédito de comisión closed-loop — solo sirve para pagar comisiones de plataforma.
>
> **Fecha de ejecución:** 2026-05-18
> **Rama:** `claude/sleepy-blackwell-7057c6`

---

## 0. Qué cambió y por qué

Antes, el conductor podía "redimir" (cashout) su saldo de TriciCoin: convertirlo en un
pago de dinero fuera de la plataforma. Eso hacía que el TriciCoin del conductor fuera un
instrumento **open-loop** (convertible a dinero) — lo cual contradice el modelo de negocio
descrito en `BUSINESS_MODEL.md` §5 (TriciCoin = crédito prepago closed-loop, no convertible
a efectivo).

Este cambio elimina la feature de redención por completo. Resultado: el saldo del conductor
solo se puede ganar dentro de la plataforma y solo se puede gastar dentro de la plataforma
(pagar comisiones de plataforma). Nunca se puede sacar como dinero.

---

## 1. Verificación de seguridad previa (Fase 1 — §5 del plan)

Antes de eliminar nada se consultó la base de datos de producción (consulta read-only vía
MCP de Supabase):

- `wallet_redemptions`: **0 filas totales.**
  - 0 con `status = 'requested'` (0 redenciones pendientes — ningún conductor esperaba un pago).
  - 0 históricas (`approved` / `processed` / `rejected`).

**Redenciones pendientes procesadas: cero — verificado.** La tabla nunca se usó. La
eliminación no descarta dinero de ningún conductor, no migra datos y no afecta a ningún
usuario real. Por estar vacía, el `DROP TABLE` es limpio y seguro.

---

## 2. Fase 2 — Eliminar el sistema de redención

### 2.1 Base de datos

Migración nueva: **`supabase/migrations/00273_remove_driver_cashout.sql`**

- `DROP TABLE public.wallet_redemptions CASCADE` — también elimina sus índices, las RLS
  `wr_select` / `wr_insert` / `wr_admin` y el CHECK `wallet_redemptions_amount_positive`.
- `DROP FUNCTION public.approve_redemption(uuid, uuid)` — el RPC de aprobación atómica (de 00189).
- `DROP TYPE public.redemption_status` — el enum ya no lo usa ninguna tabla ni función.
- `DELETE FROM platform_config` de las claves `auto_approve_redemptions_enabled` y
  `auto_approve_redemptions_max_trc`.
- `CREATE OR REPLACE FUNCTION get_admin_wallet_stats()` — se reescribe SIN consultar
  `wallet_redemptions`. Firma idéntica a la de `00003_wallet_dashboard_rpcs.sql` (mismas 3
  columnas de retorno) para no romper callers (`adminService.getWalletStats`) ni los tipos
  generados; `pending_redemptions_count` / `pending_redemptions_amount` quedan hardcodeados a `0`.

**Conservado a propósito:** el valor `'redemption'` del enum `ledger_entry_type` NO se toca.
Filas históricas del libro mayor lo referencian; quitar un valor de un enum de Postgres usado
por filas existentes es destructivo.

**No tocado a propósito:** la columna `auto_admin_runs.redemptions_approved` (de 00061) NO se
elimina — es un registro histórico de corridas del auto-admin. La edge function simplemente
deja de escribir en ella.

> La migración queda escrita como archivo en el repo. Aplicarla a producción es paso del
> pipeline de deploy (guard de MCP — el sandbox no aplica DDL a infraestructura compartida).

### 2.2 Edge function — `supabase/functions/auto-admin/index.ts`

- Eliminada la función `autoApproveRedemptions()` completa.
- Quitada de `Promise.all`, del array de errores agregados, y de la respuesta JSON / del
  update a `auto_admin_runs`.

### 2.3 API — `packages/api/src/services/admin.service.ts`

- Eliminados los métodos `getPendingRedemptions()` y `processRedemption()`.
- Quitado el import del tipo `WalletRedemption`.

### 2.4 Tipos — `packages/types/src/wallet.ts`

- Eliminada la interfaz `WalletRedemption`.

### 2.5 UI Admin

- `apps/admin/src/app/wallet/page.tsx` — eliminada la pestaña "Retiros pendientes", sus
  diálogos aprobar/rechazar, sus handlers y el fetch asociado. El tipo `Tab` queda como
  `'recharges' | 'ledger'`. Eliminada también la KPI "Monto pendiente" (mostraba el monto de
  redenciones pendientes — sería siempre `0` tras la migración).
- `apps/admin/src/app/settings/automation/page.tsx` — quitada la regla de auto-aprobación de retiros.
- `apps/admin/src/app/reports/page.tsx` — eliminadas las tarjetas "Canjes pendientes" y
  "Monto pendiente" de la sección de finanzas; la sección queda con una sola tarjeta
  (TriciCoin en circulación).
- `apps/admin/src/app/audit/page.tsx` — **sin cambios.** Conserva los labels
  `approve_redemption` / `reject_redemption` / `wallet_redemption` para poder mostrar filas
  históricas del log de auditoría.

### 2.6 i18n — `packages/i18n/src/locales/{es,en,pt}/`

`admin.json`:
- Eliminadas las claves huérfanas de la feature de redención de los bloques `wallet_admin` y
  `reports`: `pending_redemptions`, `pending_amount`, `process_redemption`, `confirm_approve`,
  `no_redemptions`, `error_processing`, `label_pending_redemptions`, `label_pending_amount`,
  `confirm_approve_redemption`, `reject_reason_redemption`, `error_processing_redemption`,
  `kpi_pending_amount`, `desc_pending_amount`.
- **Conservadas:** `action_approve_redemption` / `action_reject_redemption` /
  `target_wallet_redemption` / `target_redemption` — labels de display para filas históricas
  del log de auditoría.

`driver.json`:
- `tx_redemption` conservado, con valor renombrado a un término neutro
  ("Ajuste de saldo" / "Balance adjustment") — sigue siendo el label de transacciones
  `redemption` históricas del ledger.

---

## 3. Fase 3 — Reencuadrar el TriciCoin del conductor

El sistema de "cuota de trabajo" del conductor (el saldo `driver_cash`, del que se descuenta
la comisión de plataforma por viaje) ya funcionaba como crédito closed-loop. No requirió
cambios de lógica — sí de encuadre y copy.

- `apps/driver/app/(tabs)/wallet.tsx` — el saldo se reencuadra de "Cuota de trabajo" a
  "Crédito de comisión". Añadido el hint:
  *"Este saldo se usa solo para pagar comisiones de plataforma. No es retirable ni reembolsable."*
- `apps/driver/app/wallet/index.tsx` — la tarjeta de saldo muestra "Crédito de comisión" + el
  mismo hint de no-retirable / no-reembolsable.
- `apps/driver/app/wallet/recharge.tsx` — añadido un banner en la pantalla de recarga:
  *"Estos créditos son no reembolsables y solo sirven para pagar comisiones de plataforma."*

No había un botón de "retirar / cobrar" en la app del conductor que quitar — nunca existió una
UI de solicitud de redención (hallazgo de la Fase 1, §2 del plan).

---

## 4. Fase 4 — Documentación

- `apps/web/src/app/refunds/page.tsx` — la sección de créditos se reescribió: los créditos
  TriciCoin (del pasajero y del conductor) son **no reembolsables, no transferibles y no
  convertibles a dinero**. Antes la página decía que el saldo no consumido era reembolsable al
  cierre de cuenta — eso contradecía `BUSINESS_MODEL.md` §5 y quedó corregido.
- `BUSINESS_MODEL.md` (vive en `C:\Users\Eduardo\Downloads\`, no en el repo) — §3 aclara que
  el TriciCoin del conductor es un crédito interno no retirable / no reembolsable / no
  convertible a dinero; §11 registra el cambio de modelo con fecha.
- Este archivo (`CASHOUT_REMOVAL_LOG.md`).

---

## 5. Verificación

- **`pnpm check-types`** (`turbo run check-types`): **4/4 apps sin errores de tipos**
  (`@tricigo/admin`, `@tricigo/web`, `@tricigo/driver`, `@tricigo/client`) —
  `Tasks: 4 successful, 4 total`.
- **Grep de control:** sin referencias colgadas en CÓDIGO a `wallet_redemptions`,
  `approve_redemption`, `getPendingRedemptions`, `processRedemption` ni `WalletRedemption`.
  Las menciones restantes están solo en: (a) docs y planes; (b) migraciones históricas
  (no se editan); (c) la migración nueva 00273; (d) labels de auditoría conservados a propósito.
- **JSON:** los 3 `admin.json` validados como JSON correcto tras la limpieza de claves.

---

## 6. Alcance — qué este cambio NO hace

Eliminar el cashout hace que el TriciCoin del conductor sea **genuinamente no convertible a
dinero** — una mejora real y verificable hacia el modelo closed-loop, efectiva en código una
vez que la migración 00273 se aplique a producción.

Este cambio **no resuelve ni toca** la pregunta de sanciones / OFAC del flujo de fondos. Ese
es un tema legal independiente que sigue abierto y requiere asesoría legal real.

---

## 7. Pendiente (fuera del alcance de este cambio de código)

- **Aplicar la migración `00273` a producción** — paso del pipeline de deploy / mano humana.
  Hasta entonces, en prod siguen existiendo la tabla vacía `wallet_redemptions`, el RPC
  `approve_redemption` y el enum `redemption_status`. No causan daño (la tabla está vacía y
  ningún código vivo los llama), pero la feature no queda técnicamente eliminada de la base de
  datos hasta que la migración se aplique.

---

**Última actualización:** 2026-05-18
