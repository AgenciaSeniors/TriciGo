# Cambios de `master` desde el último merge con `lucia`

**Propósito:** dar a lucia (y a cualquier merge futuro) un mapa completo de lo que cambió en `master` mientras su rama trabaja el rediseño de admin, para anticipar conflictos y coordinar.

**Merge-base:** `e236977` — último `Merge branch 'master' into lucia` del **2 abr 2026**.
**Última verificación:** 2026-04-17 (post-Fase 2 i18n + fix ciclo api↔utils).
**Commits en master no presentes en lucia:** 95+.

---

## 🚨 TL;DR para lucia

- **Admin:** tocamos `apps/admin/src/app/drivers/page.tsx`, `apps/admin/src/app/drivers/[id]/page.tsx`, `apps/admin/src/app/page.tsx`, `apps/admin/next.config.ts` y `packages/api/src/services/admin.service.ts`. **Si tu rediseño toca estos archivos, hay conflicto garantizado.**
- **i18n admin (NUEVO 2026-04-17):** restauramos `useTranslation` + `t()` wrapping en **22 páginas admin** (Fase 2 completa). Lucia migró esas páginas pero había dropeado las llamadas `t()` — ya están de vuelta sin romper el diseño nuevo (`defaultValue` = string exacto de Lucia). Cambios en `packages/i18n/src/locales/{es,en,pt}/admin.json` (~1770 keys cada uno), `apps/admin/src/lib/status-registry.ts`, y los componentes `StatusBadge` / `FilterBar` / `DataTable`.
- **Ciclo `api ↔ utils` (NUEVO 2026-04-17):** `trackValidationEvent` se movió de `packages/utils/src/analytics.ts` a `packages/api/src/services/validation.service.ts`. Driver apps importan desde `@tricigo/api` ahora.
- **Driver/Client/Packages:** trabajo pesado que lucia probablemente **no toca** — pero confirmar.
- **Supabase:** 10 migrations nuevas (00116 → 00128). **Si lucia creó alguna migration con número ≤ 00128, renombrar.**

---

## 1. Archivos tocados — organizados por área

### 1.1 Admin app (zona roja 🔴 — lucia trabaja acá)

| Archivo | Qué se cambió | Commits |
|---|---|---|
| `apps/admin/src/app/drivers/page.tsx` | **Rediseño completo** de la lista de drivers: filter bar unificado, status dots, vehicle icons, avatar initials, card list mobile, tiempo relativo | `327ef02` |
| `apps/admin/src/app/drivers/[id]/page.tsx` | **Rediseño completo** del detail page: layout 2-col, sticky right panel, doc cards con verify/reject inline, metrics, actions dropdown. Además soporte PDF upload (`b0629c7`) | `327ef02`, `b0629c7` |
| `apps/admin/src/app/page.tsx` | Fix widget de pending drivers (incluye `under_review`) | `ae54554` |
| `apps/admin/next.config.ts` | Varios rounds: transpilePackages expo, reversión tras indirect require | `6eb397a`, `b4593bc`, `a92ea55` |
| `apps/web/next.config.ts` | Mismo patrón que admin | `6eb397a`, `b4593bc`, `a92ea55` |
| `packages/api/src/services/admin.service.ts` | `getPendingDrivers()` nuevo (queries `pending_verification` + `under_review`), dedup de documentos por type en `getDriverDetail()` | `ae54554`, `0469454` |

**Si lucia está rediseñando drivers list/detail → CONFLICT GARANTIZADO.** Coordinar: o lucia hace rebase antes de mergear, o yo mergeo lo suyo dentro de lo mío manualmente.

### 1.2 Driver app (zona verde 🟢 — probable no colisión)

**Pantallas:**
- `apps/driver/app/(tabs)/index.tsx` — wire de `useDemandHotspots` + `useNearbyDrivers` + heatmap replacement
- `apps/driver/app/(tabs)/earnings.tsx` — **+2 StatCards** (rides/hora, $/hora) + **EarningsByZoneChart** integrado bajo HourlyHeatmap
- `apps/driver/app/wallet/index.tsx` — **bug fixes críticos** (driver_cash, account_id) + botón export CSV en header
- `apps/driver/app/onboarding/documents.tsx` + `app/profile/documents.tsx` — soporte PDF
- `apps/driver/app/onboarding/vehicle-info.tsx` — border radius + placeholder

**Componentes nuevos:**
- `apps/driver/src/components/HotspotPulseMarker.tsx` — pulse marker para demand hotspots
- `apps/driver/src/components/EarningsByZoneChart.tsx` — chart horizontal top 5 zonas

**Hooks nuevos:**
- `apps/driver/src/hooks/useNearbyDrivers.ts` — polling 20s de peer drivers
- `apps/driver/src/hooks/useDemandHotspots.ts` — polling 30s de zonas calientes
- `apps/driver/src/hooks/useDriverEarningsByZone.ts` — fetch único por período

**Hooks eliminados:**
- `apps/driver/src/hooks/useDemandHeatmap.ts` — **borrado** (dead code, reemplazado por useDemandHotspots)

**Componentes modificados:**
- `apps/driver/src/components/RideMapView.tsx` — nuevos props `nearbyDrivers` y `demandHotspots`, MapboxGL.SymbolLayer para peers, PointAnnotation para hotspots
- `apps/driver/src/components/IncomingRideCard.tsx` — progress bar ligado a `offer_expires_at` real del server + color verde→amarillo→rojo
- `apps/driver/src/components/DriverTripView.tsx` — currency fix
- `apps/driver/src/components/HomeBottomSheet.tsx` — currency fix
- `apps/driver/src/stores/ride.store.ts` — `removeStaleRequests` usa `offer_expires_at` en vez de TTL local

**Assets:**
- `apps/driver/assets/vehicles/selection/moto.{png,@2x,@3x}` — replaced transparent background

### 1.3 Client app (zona verde 🟢)

- `apps/client/app/(tabs)/index.tsx` — `SearchingView` ahora muestra countdown real + conteo de drivers evaluando; currency fix
- `apps/client/src/hooks/useRideOfferStats.ts` — **nuevo** (polling 3s)
- `apps/client/src/components/RideActiveView.tsx` — currency fix
- `apps/client/app/(tabs)/wallet.tsx` — currency fix

### 1.4 Web app (zona verde 🟢, excepto next.config.ts)

- `apps/web/src/app/book/page.tsx` — currency fix
- `apps/web/next.config.ts` — transpile changes

### 1.5 Packages (zona amarilla 🟡 — verificar)

**`packages/api/src/services/`:**
- `ride.service.ts` — cambios masivos: `getSearchingRides()` query `ride_offers` con JOIN, `subscribeToNewRides()` suscribe a `ride_offers`, `cancelRide()` delega a RPC, `getDemandHotspots()`, `getRideOfferStats()`
- `driver.service.ts` — FormData upload pattern + `getTripHistoryByDateRange` (ya existía), PDF upload support
- `admin.service.ts` — `getPendingDrivers()`, dedup de docs
- `wallet.service.ts` — `getSummary(userId, accountType?)` con segundo param opcional, `getDriverEarningsByZone()` nuevo

**`packages/types/src/`:**
- `ride.ts` — nuevos tipos: `offer_expires_at` en Ride, `DemandHotspot`, `RideOfferStats`
- `wallet.ts` — `WalletSummary.account_id`, `WalletAccountKind`, `DriverEarningsByZone`
- `driver.ts` — campos PDF

**`packages/utils/src/`:**
- `haptics.ts` + `haptics.native.ts` — **split platform extensions** (nueva arquitectura)
- `sounds.ts` + `sounds.native.ts` — mismo patrón
- `historyExport.ts` — `generateHistoryCSV` (existente) + **`generateWalletCSV` nuevo**
- `index.ts` — nuevos exports

**`packages/ui/src/`:**
- `Text.tsx` — fix `inverse` → siempre blanco

**`packages/i18n/src/locales/`:**
- `{es,en,pt}/{driver,rider}.json` — currency fixes + keys para wallet/earnings nuevos

---

## 2. Supabase migrations — 10 nuevas

| # | Archivo | Qué hace | ¿Colisión con admin? |
|---|---|---|---|
| **00115** | `allow_driver_negative_balance.sql` | Permite balance negativo solo en driver accounts (commission debt pattern) | No |
| **00116** | `document_mime_type.sql` | PDF support en driver_documents | Parcial (admin ve docs) |
| **00117** | `driver_documents_storage_rls.sql` | Storage RLS inicial | No |
| **00118** | `consolidate_driver_documents_storage_rls.sql` | Consolida 7 policies en 3 | No |
| **00119** | `accept_ride_auth_check.sql` | `auth.uid()` check + `SET search_path` en `accept_ride` | No |
| **00120** | `ride_offers.sql` | **Arquitectura `ride_offers`** — tabla nueva + `dispatch_ride` RPC + trigger + cron | No |
| **00121** | `cancel_ride_rpc.sql` | `cancel_ride` RPC + restaura `apply_cancellation_fee` / `calculate_cancellation_fee` (estaban droppeadas) + trigger guard de columnas | No |
| **00122** | `secdef_search_path_hardening.sql` | `SET search_path` a 63 SECURITY DEFINER | No |
| **00123** | `rpc_attempt_log.sql` | Tabla `rpc_attempt_log` + instrumentación en `accept_ride`/`cancel_ride` | No |
| **00124** | `fix_push_notification_trigger.sql` | Reemplaza JWT hardcoded por vault lookup | No |
| **00125** | `demand_hotspots.sql` | `hourly_demand_cells` materialized view + `get_demand_hotspots` RPC | No |
| **00126** | `ride_offers_retry.sql` | `dispatch_round` + `retry_dispatch_expired_rides` cron | No |
| **00127** | `rider_offer_stats.sql` | `get_ride_offer_stats` RPC | No |
| **00128** | `driver_wallet_fixes_and_analytics.sql` | Fix `get_wallet_summary` + `get_driver_earnings_by_zone` | No |

**⚠️ Si lucia agregó migrations con número ≤ 00128 → hay que renombrar la suya.**

---

## 3. Features / arquitecturas nuevas que lucia probablemente no conoce

### 3.1 `ride_offers` table (migration 00120)
Cambia cómo los drivers descubren rides. Ya no es broadcast a todos — ahora hay una tabla `ride_offers` con top-10 candidates y expiry de 30s. Implica:
- Si el admin muestra rides en status `searching`, ahora tiene tabla `ride_offers` para saber a quién se le envió.
- `rides.dispatch_round` es nueva columna (0..3).
- Cancel reason nueva: `no_drivers_accepted`, `no_drivers_available`.

### 3.2 `rpc_attempt_log` (migration 00123)
Tabla admin-only SELECT. Si lucia agrega un dashboard de "fraud detection" o similar, esta tabla ya existe.

### 3.3 Column-level UPDATE guard en rides (migration 00121)
Trigger `trg_enforce_ride_update_columns` restringe qué puede mutar cada rol. Si el admin update rides directamente (sin RPC), puede fallar — admin bypass via `is_admin()` ya está en el trigger.

### 3.4 Platform extensions en `@tricigo/utils`
`haptics.ts` es no-op, `haptics.native.ts` tiene la lógica real. Mismo con `sounds`. Metro resuelve `.native.ts` automáticamente; Webpack usa el `.ts` plano. **Si lucia importa desde admin, todo funciona** — pero no añadir más trucos de `indirect require`.

### 3.5 Vault secret `service_role_key` (migration 00124)
Ya está seteado en vault. Si lucia necesita el JWT en triggers, usar `get_service_role_key()` — no hardcodear.

### 3.6 Demand hotspots / nearby drivers (migration 00125 + hooks)
Solo driver app. Si admin quiere mostrar "dónde está la demanda" o "drivers online", reutilizar RPCs `get_demand_hotspots` y `find_nearby_vehicles`.

### 3.7 Driver wallet parametrizado (migration 00128)
`get_wallet_summary(user_id, account_type)` acepta `'customer_cash' | 'driver_cash'`. Si admin muestra balances, explicitar qué cuenta.

---

## 4. Tipos nuevos en `@tricigo/types` que lucia puede querer usar

```ts
// ride.ts
offer_expires_at?: string;          // en Ride
DemandHotspot
RideOfferStats

// wallet.ts
WalletSummary.account_id: string | null
WalletAccountKind = 'customer_cash' | 'driver_cash'
DriverEarningsByZone
```

---

## 5. RPCs nuevas disponibles

| RPC | Autorización | Uso recomendado |
|---|---|---|
| `dispatch_ride(ride_id, radius_m)` | Internal trigger | No llamar desde cliente |
| `retry_dispatch_expired_rides()` | Cron | No llamar desde cliente |
| `accept_ride(ride_id, driver_id)` | `auth.uid()` = driver | Driver app |
| `cancel_ride(ride_id, reason)` | `auth.uid()` = customer o driver | Ambas apps |
| `get_ride_offer_stats(ride_id)` | `auth.uid()` = customer o admin | Client app |
| `get_demand_hotspots(lat, lng, radius)` | Authenticated | Driver map |
| `get_driver_earnings_by_zone(driver_id, start, end)` | `auth.uid()` = driver o admin | Driver earnings |
| `get_wallet_summary(user_id, account_type)` | Authenticated | Todas las apps |
| `get_service_role_key()` | `SECURITY DEFINER` internal | Solo triggers |
| `log_rpc_attempt(...)` | `SECURITY DEFINER` internal | Solo desde RPCs |

---

## 6. Bugs que ya arreglé (no re-abrir)

- **Driver wallet screen siempre vacío** — `wallet/index.tsx:37` pasaba `userId` donde el service esperaba `accountId`. Fixed en `060c0f0`.
- **Driver wallet mostraba saldo de cliente** — `get_wallet_summary` hardcoded `customer_cash`. Fixed en 00128.
- **Total earned/spent siempre 0** — hardcoded en RPC. Fixed en 00128.
- **Admin blank page** — `expo-haptics` parseado por webpack. Fix con platform split.
- **Dashboard admin "0 pending drivers"** cuando había 5 — query no incluía `under_review`.
- **11 docs cuando solo hay 5** — cada re-upload creaba nueva fila. Dedup en `getDriverDetail()`.
- **Cash ride completion fail** — `CHECK (balance >= 0)` rompía commission debit. Migration 00115.
- **Service-role JWT hardcoded** en trigger push (migration 00022). Fixed con vault lookup en 00124.

---

## 7. Protocolo de merge sugerido

Cuando lucia termine su rama:

1. **Lucia hace pull de master** y rebasea:
   ```
   git checkout lucia
   git fetch origin
   git rebase origin/master
   ```
2. **Conflictos esperados** (orden de resolución):
   - `apps/admin/src/app/drivers/page.tsx` — aceptar versión de lucia (rediseño nuevo)
   - `apps/admin/src/app/drivers/[id]/page.tsx` — lucia
   - `apps/admin/src/app/page.tsx` — **manual** (mi fix de pending drivers + su rediseño si aplica)
   - `apps/admin/next.config.ts` — **manual** (mi transpile config + sus cambios)
   - `packages/api/src/services/admin.service.ts` — **manual** (mi `getPendingDrivers` + su código)
3. **Si lucia creó migration con número ≤ 00128** → renombrarla a 00129+.
4. **Correr `pnpm install`** por cambios en package.json.
5. **Smoke test:**
   - Admin abre sin blank page
   - Dashboard muestra pending drivers correctamente
   - Driver wallet muestra saldo correcto
   - Rider puede crear ride y driver recibe oferta con countdown

---

## 8. Archivos que **NO** he tocado (safe zone para lucia)

- Todo `apps/admin/src/components/**` (excepto si lucia agregó algo)
- `apps/admin/src/lib/**`
- Migrations 00001–00114 (intactas)
- `apps/admin/tailwind.config.*`, theme files
- `packages/theme/**`

---

## 8.5. Addendum 2026-04-17 — Fase 2 i18n + fix ciclo packages

### i18n restaurado en admin (22 páginas)

Lucia migró 22 páginas de admin a su nuevo sistema de primitivos pero dropeó las llamadas `useTranslation` y `t()`. En master, ahora las 22 páginas vuelven a usar `t('namespace.key', { defaultValue: 'Spanish exacto de lucia' })`, preservando 100% del diseño.

**Commits:** `fd9bef0`, `95ef71b`, `bd4bd89`, `d5c71a3`, `2f93c6c`, `dce8a04`, `33f5fe7`, `498567a`, `247bb4d`, `7ebfde4` (10 commits).

**Páginas tocadas:**
- Operaciones: `rides`, `incidents`, `fraud`, `validation`, `disputes`, `lost-found`
- Gente: `users`, `reviews`, `support`, `wallet`
- Crecimiento: `businesses`, `funnel`, `quests`, `referrals`, `segments`, `campaigns`
- Contenido+Sistema: `content`, `blog`, `notifications`, `audit`, `settings`, `reports`

**Infra compartida modificada:**
- `apps/admin/src/lib/status-registry.ts` — campo `i18nKey` agregado a cada StatusMeta.
- `apps/admin/src/components/data/StatusBadge.tsx` — resuelve vía `t()`.
- `apps/admin/src/components/data/FilterBar.tsx` — placeholders + arias.
- `apps/admin/src/components/data/DataTable.tsx` — error/reintentar strings.
- `packages/i18n/src/locales/{es,en,pt}/admin.json` — **~1770 keys por locale, paridad 100%**.

**Si lucia rediseñó cualquiera de estas 22 páginas en paralelo:** el conflicto NO es estructural (diseño idéntico) pero sí textual (yo agregué imports de `useTranslation` + wraps de `t()`). Reconciliar a favor de mi versión conservando los ajustes visuales nuevos de lucia.

### Ciclo `api ↔ utils` eliminado

Antes: `packages/utils/src/analytics.ts` tenía `trackValidationEvent` que hacía `await import('@tricigo/api')` dinámicamente. Turbo detectaba ciclo al declarar api como dep.

Ahora: `trackValidationEvent` vive en `packages/api/src/services/validation.service.ts`. Utils solo expone el wrapper PostHog genérico (`initAnalytics`, `trackEvent`, `identifyUser`, `resetAnalytics`). Driver apps importan `trackValidationEvent` desde `@tricigo/api`.

**Commit:** `a5aef6b`.

**Archivos:**
- **Nuevo:** `packages/api/src/services/validation.service.ts`
- **Modificados:** `packages/api/src/index.ts`, `packages/api/package.json`, `packages/utils/src/analytics.ts`, `packages/utils/src/index.ts`, `apps/driver/app/(tabs)/index.tsx`, `apps/driver/src/components/DriverTripView.tsx`, `apps/driver/src/components/IncomingRideCard.tsx`.

**Si lucia tocó `analytics.ts` en paralelo:** merge debe respetar la nueva estructura — analytics.ts ya no exporta `trackValidationEvent`, el barrel `utils/index.ts` tampoco lo re-exporta.

---

## 9. Comandos útiles para lucia

```bash
# Ver mis commits
git log --oneline origin/lucia..master

# Ver archivos que modifiqué
git diff --name-only origin/lucia..master | sort -u

# Diff de un archivo específico
git diff origin/lucia..master -- apps/admin/src/app/page.tsx

# Ver qué migrations agregué
git diff --name-only origin/lucia..master -- supabase/migrations/
```

---

**Contacto:** cualquier duda sobre un archivo específico, consultar el commit correspondiente en `git log`. Los commit messages son detallados.
