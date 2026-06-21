# Auditoría panel Admin — 2026-06-20

Pase dedicado del panel admin (`apps/admin`, Next.js, desplegado en vivo en admin.tricigo.com). Foco: correctitud/contrato/dinero/i18n/robustez (la **seguridad** ya se cubrió en rondas previas — no re-litigada). Método: 3 Explore agents → pool de candidatos → verificación adversarial directa + grounding read-only contra prod (incl. un column contract-sweep mecánico).

## Resultado

Panel **bien estructurado** (ops atómicas RPC-gated, RLS, rutas de detalle `/recurso/[id]` existen, i18n parity 1777/1777/1777). La mayoría del pool resultó **refutado/ya-OK**. **3 PRs (#613/#614/#615), 0 P0/P1, cero migraciones.** Despliega en vivo (deploy-admin).

## Confirmado y arreglado
- **#613 (correctitud + fechas, P2):**
  - `updateIncidentStatus` seteaba `resolved_at` pero **nunca `resolved_by`** → se perdía quién resolvió el incidente. Fix: escribe `resolved_by=adminId` (columna verificada en prod).
  - `formatAdminDate`/`formatAdminDateShort` (formatter de fechas **compartido** del admin) sin `timeZone:'America/Havana'` → todos los timestamps en zona del navegador. Fix: anclado (alto alcance, todas las pantallas).
  - `drivers/[id]` `handleVerifyDoc`/`handleApprove`/`handleRejectOrSuspend` con `try/finally` **sin `catch`** → aprobar/rechazar/suspender/verificar fallido no daba feedback. Fix: `catch → getErrorMessage(err)` toast.
- **#614 (errores, P3):** ~80 sitios de display de error en 40 pantallas ruteados de `err.message` crudo → `getErrorMessage(err)` (misma clase que web #595/driver #611). + removido un `useTranslation`/`t` muerto en `pois/page.tsx`.
- **#615 (i18n hardcoded, P3):** `drivers` `formatRelative` (`hoy`/`ayer`/`hace N…`) y `businesses/[id]` (toasts de comisión, header, breadcrumb) → `t()`; breadcrumb reusa `sidebar.businesses`.

## Refutado / verificado limpio (NO tocar)
- **Contrato de RPCs de dinero: LIMPIO** — los 9 (`admin_adjust_wallet`, `approve_wallet_recharge`, `admin_send_gift`/`reverse_gift`, `admin_grant_grace_trips`, `promote_user_role`, `admin_refund_ride_commission`, `freeze`/`unfreeze`) coinciden en args con prod.
- **Column contract-sweep: LIMPIO** — 153 pares únicos (tabla,columna) sobre 36 tablas extraídos de `apps/admin/src` + `admin.service.ts`/`dispute.service.ts`, verificados vs `information_schema.columns`: **0 typos**, todas las tablas existen; blind spots (`.or(...)` templates, spread updates) verificados a mano.
- i18n parity admin.json es/en/pt: completa (1777×3).
- Rutas de detalle `/drivers|users|rides|incidents|businesses/[id]` existen (sin `<Link>` a rutas muertas, a diferencia del caso #454 ya resuelto).
- platform-config: escritura gated a super_admin (RLS mig 00292); KNOWN_KEYS cubre las keys leídas.
- OAuth callback (PKCE server-side + x-forwarded-host) coherente (PR #451).

## Diferido (documentado, no arreglado)
- `getOnlineDrivers` N+1 (1 query de drivers + 1 lookup de nombre por driver) → join. Perf, bajo impacto.
- `deletePricingRule` hard-delete sin confirm/audit log → soft-delete o admin_actions. Diseño.
- platform-config sin validación de rango numérico (ej. multiplicadores) → min/max en KNOWN_KEYS.
- `getAdminTransactions` muestra la magnitud máxima del entry (no el neto) — documentado "PASS #3"; revisar si conviene mostrar neto.
- `suspendDriver` no chequea viaje activo antes de `is_online=false` — probable que un trigger lo cubra; verificar si se vuelve relevante.

## Verificación
`pnpm check-types` (4 apps) + `@tricigo/api` 475 tests verde por PR; paridad admin.json es/en/pt; grounding prod read-only (columnas + RPCs). Admin desplegado en vivo → deploy-admin verde tras cada merge.
