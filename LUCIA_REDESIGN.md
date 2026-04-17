# LUCIA_REDESIGN.md — Contexto de la rama `lucia`

> **Propósito de este archivo:** dejar un registro completo del rediseño del panel de administración hecho en la rama `lucia`, para que futuras sesiones (o quien compare con `master`) entienda rápido qué cambió, por qué, qué queda pendiente, y qué deuda técnica se acumuló.
>
> **Última actualización:** 2026-04-17
> **Rama base:** `lucia` (divergida de `master` con merge `215d947`)

---

## 1. Resumen ejecutivo

La rama `lucia` rediseña completamente la app **`apps/admin/`** de TriciGo con una identidad visual editorial y cubana, reemplazando el look "Tailwind genérico / Linear-Vercel-Notion" por un sistema con personalidad:

- **Tipografía:** Bricolage Grotesque (display) + Instrument Sans (body) + Instrument Serif (acentos editoriales italic) + JetBrains Mono (números/IDs)
- **Temas:** Light + Dark con tokens CSS semánticos (`surface`, `ink`, `line`)
- **Atmósfera:** Grain overlay sutil (SVG noise inline) + aurora cubana (orange + cuba-blue)
- **Voz:** Español cubano neutro — profesional, claro, sin modismos fuertes
- **Responsive:** Card-stack en móvil (<md), tabla en desktop, bottom nav móvil
- **Identidad geográfica:** 16 provincias cubanas (ProvinceSwitch), reloj único `America/Havana`, mapa estilizado de la isla

**Stack agregado:** ninguno. Solo primitivos propios sobre Tailwind + Lucide. Sin dependencias nuevas.

---

## 2. Commits en `lucia` (orden cronológico)

| SHA | Título | Qué cambia |
|---|---|---|
| `a0fc1eb` | `feat(admin): redesign shell with trinational identity and responsive layout` | Fase 1 — shell, sidebar, header, bottom nav, tokens CSS, fuentes. **(Identidad inicial trinacional, corregida luego)** |
| `43bdec8` | `feat(admin): Cuban-focused dashboard with KPIs, pulse map and activity feed` | Fase 2 + **Fase 2.5**: dashboard nuevo + corrección trinacional → cubana (ProvinceSwitch, DashboardHero, PulseMap, CLAUDE.md) |
| `4d889d0` | `feat(admin): introduce DataTable, FilterBar and status primitives` | Fase 3 — primitivos de datos (`components/data/`, `lib/status-registry.ts`, `/preview/data`) |
| `215d947` | `Merge remote-tracking branch 'origin/master' into lucia` | Trae commits paralelos de master: drivers redesign `327ef02`, fixes expo/haptics, dashboard widget under_review, RLS driver-documents |
| `9eec0f3` | `feat(admin): migrate Operaciones pages to new data primitives` | Fase 4 grupo 1 — rides, incidents, fraud, validation, disputes, lost-found |
| `346a695` | `feat(admin): migrate Gente pages (users, reviews, support, wallet)` | Fase 4 grupo 2 — 4 pages (drivers intacta) |
| `70e7d84` | `feat(admin): migrate Crecimiento pages to data primitives` | Fase 4 grupo 3 — businesses, funnel, quests, referrals, segments, campaigns |
| `8f4652e` | `feat(admin): migrate Contenido pages (content, blog, notifications)` | Fase 4 grupo 4 — 3 pages |
| `c5bb512` | `feat(admin): migrate Sistema pages (audit, settings hub, reports header)` | Fase 4 grupo 5 — audit, settings hub, reports (header + KPIs + health section) |

---

## 3. Arquitectura del rediseño

### 3.1 Shell (Fase 1)

**Archivos clave:**
- `apps/admin/src/app/globals.css` — tokens CSS (`--surface`, `--ink`, `--line`), grain SVG overlay, aurora gradient, focus rings, scrollbars
- `apps/admin/src/app/layout.tsx` — script anti-FOUC de tema, `suppressHydrationWarning`
- `apps/admin/src/components/layout/ThemeProvider.tsx` — light/dark persistido en `localStorage['admin-theme']`
- `apps/admin/src/components/layout/AdminShell.tsx` — grid responsive + bypass de auth (`?__preview=1`, solo NODE_ENV=development)
- `apps/admin/src/components/layout/Sidebar.tsx` — 6 grupos numerados (01 Panorama, 02 Operación, 03 Gente, 04 Crecimiento, 05 Contenido, 06 Sistema), brand "TriciGo." con dot naranja, footer italic "Cuba, en movimiento"
- `apps/admin/src/components/layout/Header.tsx` — breadcrumb mono uppercase + title display, search global ⌘K, ProvinceSwitch, theme toggle, bell, user menu
- `apps/admin/src/components/layout/BottomNav.tsx` — 5 items mobile (Pulso, Viajes, Mapa, Soporte, Más)
- `apps/admin/src/components/layout/ProvinceSwitch.tsx` — chip con 16 provincias + "Todo Cuba"
- `apps/admin/src/components/layout/SidebarContext.tsx` — estado colapsado persistido

**Tailwind preset:** `packages/theme/tailwind-preset.js` extendido con `cuba.{blue,red,star}`, `surface`, `ink`, `line`, `fontFamily.display/editorial`, `boxShadow.elev-{1,2,3}`, `boxShadow.glow-primary`, animations `fade-in`/`shimmer`/`pulse-ring`.

### 3.2 Dashboard (Fase 2)

**Archivos nuevos:** `apps/admin/src/components/dashboard/`
- `DashboardHero.tsx` — saludo contextual por hora + reloj La Habana CUT + date larga
- `KpiCard.tsx` — hero/default variants, tone (default/primary/success/warning/danger/info), sparkline, delta %, editorial italic value
- `Sparkline.tsx` — SVG puro, smooth path + dot final, sin deps
- `SectionCard.tsx` — card con eyebrow + title + description + action link
- `ActivityRow.tsx` — row primitivo (icon tone + primary + secondary + trailing + href)
- `PulseMap.tsx` — silueta estilizada de Cuba con 6 anchors (PR, HAB, VC, CMG, HOL, SCU) + dots animados + stats strip editorial

El dashboard (`apps/admin/src/app/page.tsx`) consume todo: hero → 6 KPIs → PulseMap + pendientes → viajes recientes + auto-actions.

### 3.3 Primitivos de datos (Fase 3)

**Archivos nuevos:** `apps/admin/src/components/data/` + `apps/admin/src/lib/status-registry.ts`

- **`DataTable<T>.tsx`** — schema declarativo (`DataColumn<T>[]`), sort controlado, pagination controlada, rowHref/onRowClick, rowActions, loading/error/empty slots, **card-stack automático en móvil** usando `primary`/`secondary`/`hideInCard`/`cardLabel`
- **`DataTablePagination.tsx`** — prev/next + page-size selector + summary
- **`TableSkeleton.tsx`** — column-aware (respeta `hideBelow`)
- **`FilterBar.tsx`** — sticky tabs + search + children slot para filtros avanzados + badge de active count
- **`StatusBadge.tsx`** — una línea: `<StatusBadge domain="ride" status={r.status} />`
- **`DataEmptyState.tsx`** — reemplaza `AdminEmptyState` (emojis) con Lucide icons + tone
- **`lib/status-registry.ts`** — 12 dominios (`ride`, `driver`, `incident`, `dispute`, `payment`, `verification`, `lost_item`, `support`, `corporate`, `campaign`, `quest`, `referral`)

**Demo:** `/preview/data?__preview=1` — showcase con loading/empty/error toggles, sort, pagination, status badges.

### 3.4 Páginas migradas (Fase 4) — 22 de ~26

| Grupo | Páginas migradas | Patrón dominante |
|---|---|---|
| **Operaciones** | rides, incidents, fraud, validation, disputes, lost-found | DataTable + FilterBar · disputes/lost-found con list+detail split |
| **Gente** | users, reviews, support, wallet | DataTable + KpiCards · support con chat-layout · wallet con 3 tabs |
| **Crecimiento** | businesses, funnel, quests, referrals, segments, campaigns | DataTable · funnel con forma editorial · segments con KpiCard selectors |
| **Contenido** | content, blog, notifications | content con Lucide icon tiles · notifications con SectionCards |
| **Sistema** | audit, settings hub, reports (parcial) | settings como grid agrupado por dominio · reports con header + health refreshed |

**Intencionalmente no tocadas en Fase 4:**
- `apps/admin/src/app/drivers/page.tsx` — master tiene su propio redesign (`327ef02`), preservada por pedido explícito
- `apps/admin/src/app/drivers/[id]/page.tsx` — mismo motivo
- `apps/admin/src/app/live-map/page.tsx` — Mapbox-heavy, pase dedicado
- `apps/admin/src/app/reports/page.tsx` — ~500 líneas de charts custom, solo header/KPIs/health refreshed
- `apps/admin/src/app/settings/*/` — 13 sub-pages (pricing, zones, surge-zones, surge-dashboard, promotions, feature-flags, exchange-rate, platform-config, automation, experiments, cities, live-map, service-types)
- `apps/admin/src/app/login/page.tsx` — Fase 5 del plan, nunca ejecutada
- `apps/admin/src/app/forgot-password/page.tsx` + `apps/admin/src/app/reset-password/page.tsx` — idem

---

## 4. Identidad cubana (Fase 2.5)

El proyecto fue descrito incorrectamente en el `CLAUDE.md` inicial como "Tríplice Fronteira (Brasil/Paraguay/Argentina)". Fase 1 y 2 heredaron esa dirección hasta que el usuario corrigió:

**El código de `packages/utils/src/cuba-geo.ts` tiene las 16 provincias y 168 municipios de Cuba, `formatCUP` existe, y los commits mencionan "Cuban address format".**

**Correcciones aplicadas en `43bdec8`:**
- `TrinationalSwitch.tsx` → `ProvinceSwitch.tsx` (renamed via `git mv`)
- Removidas `colors.flag.{br,py,ar}` del preset, agregadas `colors.cuba.{blue,red,star}`
- Aurora recoloreada: verde/rojo/azul trinacional → orange + cuba.blue
- `DashboardHero`: 3 relojes (Sao Paulo/Asuncion/Buenos Aires) → 1 reloj `America/Havana` con label "CUT" + "16 provincias · 168 municipios"
- `PulseMap`: triángulo BR/PY/AR → silueta de Cuba con 6 ciudades
- Copy: "Tríplice Fronteira" → "Cuba"; "Movimiento sin fronteras" → "Cuba, en movimiento"
- `CLAUDE.md`: sección "Proyecto" y "Contexto trinacional" reescritas

---

## 5. Comparativa con `master` (rama en la que están trabajando en paralelo)

### Qué hace master distinto
- `327ef02` **drivers redesign** — aesthetic "Linear/Vercel/Notion" con gradientes hardcoded, emojis pseudo-status, colores Tailwind directos (`yellow-500`, `bg-green-100`, etc.) — **NO usa nuestros tokens ni primitivos**. Preservada en lucia por pedido del usuario.
- `b4593bc`, `a92ea55`, `6eb397a`, `5dc8f4b` — fixes de transpile `expo-*` + haptics/sounds (mergeados a lucia)
- `ae54554` — dashboard widget under_review (mergeado)
- `0469454` — dedupe driver documents (mergeado)
- `e0ba550` — RLS driver-documents consolidado (mergeado)

### Si vas a hacer un merge lucia → master
- **Riesgo alto:** `drivers/page.tsx` y `drivers/[id]/page.tsx` son completamente diferentes (master = Linear-style, lucia = preservada idéntica a master). Resolver a favor de master si querés mantener la estética actual de drivers, o migrarla a nuestros primitivos si querés consistencia.
- **Riesgo bajo:** el resto de cambios (shell, dashboard, primitivos, 22 páginas migradas, Cuban identity) no choca con master porque master no tocó esos archivos.
- Master también depende de nuestras deps nuevas: ninguna (usamos solo Tailwind + Lucide ya presentes).

---

## 6. Deuda técnica acumulada en `lucia`

### 6.1 Crítica
1. **i18n roto en las 22 páginas migradas.** Reemplacé llamadas `t('key')` por strings hardcodeados en español. La app soporta EN/FR/PT/GN (ver `packages/i18n/src/locales/`) pero estas páginas ya no honran el idioma del usuario. El shell (Header/Sidebar) sí mantiene `t()` con `defaultValue`. **Fix necesario:** restaurar claves i18n usando `defaultValue` con el español cubano como fallback.

### 6.2 Media
2. **50 PNGs en commit `9eec0f3`** — assets de `apps/client/assets/vehicles/` y `apps/driver/assets/vehicles/` quedaron pegados al commit de Operaciones por un merge accidental. Son cambios locales preexistentes del usuario, no introducidos por este rediseño.
3. **Type errors preexistentes (no introducidos por lucia, tampoco resueltos):**
   - `apps/admin/src/app/drivers/[id]/page.tsx:694` — i18n tuple type
   - `apps/admin/src/app/drivers/page.tsx:377` — `is_on_break` no existe en `DriverProfileWithUser`
   - `packages/api/src/services/ride.service.ts:412` — `wallet_ratio` no existe en RideRequest
4. **`/preview/data`** — ruta dev-only (gated por `NODE_ENV === 'development'` en `middleware.ts`), nunca linkeada desde navegación. Útil para QA visual; decidir si eliminar antes de merge a master.

### 6.3 Baja
5. **`AdminEmptyState` y `AdminTableSkeleton`** — legacy, seguros porque nadie los usa ya en las 22 páginas migradas; solo quedan en `drivers`, `live-map`, `reports` chart-sections y `/settings/*` sub-pages.

---

## 7. Convenciones introducidas (guía para futuros cambios)

### 7.1 Layout de página típico

```tsx
<div className="flex flex-col gap-5">
  {/* Header */}
  <div>
    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
      {grupo} · {sub}
    </p>
    <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em] text-ink md:text-[30px]">
      {Title}
    </h1>
    <p className="mt-0.5 text-[12.5px] text-ink-muted">{descripcion}</p>
  </div>

  {/* FilterBar sticky */}
  <FilterBar tabs={...} activeTab={...} onTabChange={...} sticky />

  {/* DataTable */}
  <DataTable columns={...} rows={...} keyField="id" pagination={...} empty={...} />
</div>
```

### 7.2 Tokens de Tailwind disponibles
- **Surfaces:** `bg-surface`, `bg-surface-elevated`, `bg-surface-sunken` (CSS vars automáticas light/dark)
- **Ink:** `text-ink`, `text-ink-muted`, `text-ink-subtle`
- **Lines:** `border-line`, `border-line-strong`
- **Brand:** `bg-primary-500` (naranja), `bg-cuba-blue`, `bg-cuba-red`
- **Tonos:** success (emerald), warning (amber), danger (red), info (sky)
- **Shadows:** `shadow-elev-{1,2,3}`, `shadow-glow-primary`
- **Fonts:** `font-sans` (Instrument Sans), `font-display` (Bricolage), `font-editorial` (Instrument Serif italic), `font-mono`
- **Animations:** `animate-fade-in`, `animate-pulse-ring`, `animate-shimmer`
- **Transition easing:** `ease-spring`, `ease-out-expo`

### 7.3 Voz
- Cubano neutro profesional
- Evitar emojis (anti-patrón de la guía UI)
- Headlines cortos, Bricolage Grotesque
- Números grandes en Instrument Serif italic con `data-tabular`
- Eyebrows en `font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle`

### 7.4 Responsive
- Mobile-first
- DataTable: tabla en `md+`, card-stack en `<md` (automático)
- Bottom nav en `<md`
- Sidebar: drawer en `<md`, rail colapsable en `md+`

---

## 8. Archivos clave para leer si querés entender rápido

**Entender el sistema:**
1. `apps/admin/src/app/globals.css` — tokens
2. `packages/theme/tailwind-preset.js` — extensión Tailwind
3. `apps/admin/src/components/layout/AdminShell.tsx` — armado del shell
4. `apps/admin/src/components/data/DataTable.tsx` — primitivo central de tablas
5. `apps/admin/src/lib/status-registry.ts` — registro único de status

**Ver ejemplos:**
6. `apps/admin/src/app/rides/page.tsx` — página list típica completa
7. `apps/admin/src/app/disputes/page.tsx` — list + detail split
8. `apps/admin/src/app/wallet/page.tsx` — multi-tab con KPIs + confirm modal
9. `apps/admin/src/app/validation/page.tsx` — analytics con KpiCard hero + 2 DataTables

**Dashboard:**
10. `apps/admin/src/app/page.tsx` + `apps/admin/src/components/dashboard/*`

---

## 9. Próximos pasos recomendados

En orden de ROI:

1. **Arreglar i18n** en las 22 páginas (crítico si los usuarios están en varios idiomas)
2. **Fase 5: login/forgot-password/reset-password** — completa identidad
3. **QA sistemático** (375/768/1440 × light/dark × 22 pages) — encontrar bugs antes del usuario
4. **Decidir sobre `/drivers`** — re-alinear con primitivos o dejar como está
5. **`/settings/*` sub-pages** — 13 páginas en pase dedicado
6. **`/reports` charts internos** + **`/live-map`** — pases analíticos/mapa dedicados

---

## 10. Contacto y autoría

- Autor del rediseño: Claude Opus 4.7 (1M) con dirección de `@AgenciaSeniors` en sesión colaborativa
- Rama: `lucia` en `github.com/AgenciaSeniors/TriciGo`
- Plan original vivo: `C:\Users\Lucia Soler\.claude\plans\indexed-puzzling-fairy.md` (local)
