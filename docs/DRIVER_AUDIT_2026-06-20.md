# Auditoría app Driver (conductor) — 2026-06-20

Pase dedicado de la app del conductor (`apps/driver`, Expo/RN, mobile-only). Foco: bugs/robustez/dinero/i18n/a11y/contrato (no paridad — no hay driver web). Método: 3 Explore agents → pool de candidatos → verificación adversarial directa contra el código actual + grounding read-only contra prod.

## Resultado

La app está **bastante sana**. Pool de candidatos en su mayoría **refutado** (~la mitad, como en las tandas anteriores). **4 hallazgos P3 confirmados → 1 PR ([#611](https://github.com/AgenciaSeniors/TriciGo/pull/611)), 0 P1, cero migraciones.** Ships en el próximo rebuild del APK (no afecta builds en revisión).

## Confirmado y arreglado (#611)
- **Errores crudos al usuario → `getErrorMessage(err)`** (misma clase que web #595) en `trips`, `(tabs)/wallet`, `profile/{penalties,reviews,vehicle,documents}`, `onboarding/documents`. Red/abort/PostgREST muestran español amable en vez de inglés crudo.
- **`earnings/RecentActivitySection`**: fecha de actividad sin `timeZone:'America/Havana'` (inconsistente con `wallet.tsx`) → anclada a Havana.
- **i18n**: 4 keys `onboarding.switch_account*` existían solo en es → drivers EN/PT veían español. Agregadas a en/pt (driver.json parity **646/646/646**).
- **`wallet.service.ts`**: doc-comments stale ("drivers pass driver_cash") → corregidos a `tricicoin` (mig 00300). Docs only.

## Refutado por verificación (NO tocar)
- **Contrato**: `admin_actions.reason`/`action`, `driver_profiles.suspended_reason`/`is_on_break` **existen** en prod (grounding `information_schema.columns`). La columna es `suspended_reason` (no `suspension_reason`), que el código usa. Correcto.
- **Timeouts**: no hay fetch externo bloqueante sin timeout — los únicos fetch directos son DNS pre-warm de Mapbox (fire-and-forget `.catch(()=>null)`; `useMapboxReady` ya usa `signal`). La línea ~448 de `useDriverLocation` es el upload GPS por RPC (timeout global del cliente Supabase).
- **a11y**: `IncomingRideCard` (aceptar/rechazar) y `TripActionToolbar` (navegar/chat/SOS) **ya tienen** `accessibilityRole`+`accessibilityLabel`.
- **Recarga NETOPIA**: ya pollea el intent en el return (`openAuthSessionAsync` + "ALWAYS poll"); estado no se pierde.
- **i18n keys "faltantes"** (wallet.fetch_error, home.popular_zones_toggle, etc.): usan `t(k,{defaultValue})` por convención (no están en ningún locale) → renderizan bien; no son bug (CLAUDE.md lista esos toggles como intencionales).

## Ya OK (mapeado, sin cambios)
heartbeat con cleanup (triple pero inocuo), guards anti-doble-tap accept/complete, retry+idempotencia al completar, GPS throttle/cleanup, gates OTP+foto en entrega, `classifyWalletTxn` cobertura completa (fx_revaluation/insurance/refund), earnings/wallet leen `tricicoin`, `subscribeToRide` no-op con polling de respaldo, 12 `exhaustive-deps` de `index.tsx` (intencionales).

## Verificación
`pnpm check-types` (4 apps) verde; `@tricigo/api`/`@tricigo/utils` tests verdes; paridad i18n driver.json 646/646/646; grounding prod read-only de columnas. Mobile → se prueba en el próximo rebuild/dev-client.
