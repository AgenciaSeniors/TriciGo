# Auditoría de frescura de datos — clase "stale-on-mount" (2026-06-21)

> Disparada por el bug del saldo del home (#631). El usuario pidió que **las auditorías cubran esta clase** de forma permanente **y** arreglar el backlog **exhaustivamente** con el enfoque **más robusto**.

## La clase

En las apps Expo (cliente/conductor) los **tabs no se desmontan** al cambiar de tab. Una pantalla que trae **dato mutable** con `useEffect(() => Service.getX(...), [deps])` **una sola vez al montar** y **sin** mecanismo de refresco queda **congelada** en el valor de cuando se abrió la app, hasta un reinicio — aunque el dato cambie por fuera (crédito de admin, regalo, pago de viaje, rating, estado de aprobación, penalización). Antes: **solo 5 archivos** del repo usaban `useFocusEffect` (los 2 wallets + el home #631 + driver `profile/edit` + web wallet); todo lo demás era stale-prone.

## El primitivo (lo más robusto + DRY)

**`useRefreshOnFocus(refetch)`** — `apps/<app>/src/hooks/useRefreshOnFocus.ts` (por app). Refetch al **ganar foco** (`useFocusEffect`) + al volver del **background** (`AppState 'active'`). Guarda `refetch` en un **ref** → las subscripciones quedan estables (deps `[]`), así es **loop-safe** aunque el caller pase un `refetch` inestable (uno que cierra sobre estado que cambia tras el fetch, ej. notifications). Cubre los casos prácticos (navegar-y-volver, background→foreground) sin el costo/RLS de realtime.

## Pantallas migradas (13 — cada una groundeada)

**Cliente (7, #633):** `(tabs)/rides` (historial), `notifications`, `profile/referral`, `profile/corporate` (request status + accounts), `profile/trusted-contacts`, `profile/devices`, `profile/settings`. + `useCorporateAccounts` ahora expone `refetch`.

**Conductor (6, #634):** `(tabs)/trips` (historial), `profile/reviews` (rating), `profile/performance` (tasas), `profile/penalties`, `profile/documents` (verificación), `notifications`.

**Verificación:** `grep -rl useRefreshOnFocus apps/*/app` = 13 archivos. `pnpm check-types` verde (4 apps) en cada PR.

## A RESPETAR / dejado (no son stale-bugs)
- **Dato store-synced:** lo que vive en `useAuthStore`/`useDriverStore` y se actualiza por `setUser`/realtime — tier/level, nombre, y los **stats del profile-tab del conductor** (sincronizados por el canal realtime `driver_profiles`). Ya reactivo; no se tocó.
- **Config casi-estática:** `commission_rate`, `service_type_configs` — refetchear a cada foco es desperdicio sin beneficio (cambian rara vez por admin).
- **Marker de vehículo del home del conductor:** bajo valor (icono del mapa); el home es la pantalla principal del conductor online y de alto riesgo para tocar. Asimetría cosmética con el refresh de `edit.tsx`.
- **Realtime:** lift mayor; el codebase lo evita a propósito (BUG-277) salvo casos puntuales (driver `driver_profiles`, ride offers, polling de viaje activo). `useRefreshOnFocus` cubre el caso práctico.

## Dimensión PERMANENTE de auditoría
Documentada en **CLAUDE.md** → "Auditoría de frescura de datos (stale-on-mount)": la regla (todo dato mutable debe usar `useRefreshOnFocus`/`useFocusEffect`/realtime), **cómo barrer** (`grep -L useFocusEffect` + cross-check sibling), qué NO tocar, y el fix canónico. **Futuras auditorías la chequean.**

## PRs
- **#631** — home balance (el caso disparador; useFocusEffect+AppState inline).
- **#632** — Fase 0: hook `useRefreshOnFocus` + dimensión en CLAUDE.md.
- **#633** — Fase 1: 7 pantallas cliente + hardening del hook (ref-based).
- **#634** — Fase 2: 6 pantallas conductor.

## Notas
- **Requiere rebuild de APK (v6)** — todos son cambios mobile; v5 mantiene el comportamiento viejo.
- Smoke por pantalla tras el build: cambiar el dato por fuera (admin/SQL) → volver a la pantalla o background→foreground → debe actualizarse sin reiniciar.

## Procedencia
Auditoría 2026-06-21. 2 agentes Explore (cliente + conductor) mapearon REACTIVE vs STALE-PRONE; grounding manual de cada pantalla antes de tocar. Plan: `~/.claude/plans/vamos-a-hacer-un-gentle-sketch.md`.
