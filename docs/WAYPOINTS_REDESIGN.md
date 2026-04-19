# Rediseño de paradas intermedias (waypoints)

**Branch:** `master`
**Started:** 2026-04-19
**Driver:** Feedback directo del usuario tras probar v1.1.5 en un Samsung:
> "La parte de las paradas no está bien integrada, ni en el (UI/UX), tampoco se ve en el mapa."

## Estado previo (v1.1.5)

### Lo que funcionaba
- **Backend**: tabla `ride_waypoints` + RLS + RPCs (`get_ride_waypoints_with_coords`, `get_ride_waypoints_by_share_token`) aplicadas en prod.
- **Polyline**: `useRoutePolyline` soporta `waypoints?: GeoPoint[]` y llama a `fetchMultiStopRoute` correctamente.
- **Realtime**: `subscribeToWaypoints` + re-fetch via RPC.
- **Share web**: `TrackingMap` renderiza markers naranja numerados + multi-stop route en `/track/share/[token]`.

### Lo que estaba roto (UX)

| # | Problema | Archivo | Línea |
|---|---|---|---|
| 1 | Solo se agregan paradas DESPUÉS del `in_progress` (viaje arrancado) | `apps/client/src/components/RideActiveView.tsx` | 989 |
| 2 | Emojis 📍 ✅ como iconos de estado (viola regla `no-emoji-icons` del design system) | `RideActiveView.tsx` | 980-983 |
| 3 | Preview hardcodeado `"Agregar parada · +~$200 · +~5 min"` — no refleja el viaje | `RideActiveView.tsx` | 1000 |
| 4 | No se puede eliminar una parada (tap wrong → permanece) | N/A | — |
| 5 | No se puede reordenar paradas | N/A | — |
| 6 | Markers de mapa (ring naranja 24×24) se confunden con puntos de la ruta | `apps/client/src/components/RideMapView.tsx` | 622-645 |
| 7 | No se distingue "próxima parada" vs "completadas" en el mapa | `RideMapView.tsx` | 622-645 |

## Plan de trabajo (3 fases)

### Fase A — Permitir agregar paradas al CREAR el viaje (no solo in_progress)

**Objetivo:** Alinear con benchmark de industria (Uber/DiDi/Cabify). El rider elige paradas ANTES de pedir conductor.

**Cambios:**
1. Nueva sección "Paradas" en `SelectingView` (home step `selecting`), entre pickup y dropoff.
2. Estado local `pendingWaypoints` en `SelectingView` — mientras no se crea el ride, son solo UI.
3. Al llamar a `requestRide` / `createRide`, pasar `waypoints` como parte de los params.
4. `createRide` de `ride.service.ts` ya acepta `waypoints` param — solo hay que conectar la UI.

### Fase B — Rediseño visual de la UX de stops

**Objetivo:** Eliminar emojis, iconos consistentes, preview real, remove/reorder.

**Cambios:**
1. Nuevo componente `<StopsEditor>` en `packages/ui/src/` — reutilizable en SelectingView e in_progress.
2. Iconos:
   - **Pending stop**: `MapPin` (Lucide) gris outline + número en círculo naranja.
   - **Current stop**: `MapPin` naranja filled + pulse ring.
   - **Completed stop**: `CheckCircle` verde filled.
3. Preview dinámico: `estimateWaypointAddition()` ya retorna `{ extraDistanceKm, extraFareCup }` — usarlo en lugar del hardcoded.
4. Botón `×` para eliminar cada parada (pending). Durante `in_progress` solo paradas NO visitadas se pueden eliminar.
5. Drag handle `≡` para reordenar (solo pending, antes del ride).

### Fase C — Mejorar markers del mapa

**Objetivo:** Paradas visibles y distinguibles en el mapa.

**Cambios:**
1. Pin alto (32-40px) en lugar de ring chico (24px).
2. Número centrado grande + dirección trunca como label.
3. Color de fondo naranja `#FF4D00` (token `cubanLight.accent.orange`).
4. Next-stop: pulse ring animation (reutilizar pattern del pickup marker).
5. Completadas: marker gris + check icon.

## Archivos afectados (previsión)

- `apps/client/app/(tabs)/index.tsx` — SelectingView: agregar sección paradas
- `apps/client/src/components/RideActiveView.tsx` — reemplazar lista actual + emojis
- `apps/client/src/components/RideMapView.tsx` — mejorar markers
- `packages/ui/src/StopsEditor.tsx` — NUEVO componente reutilizable
- `packages/ui/src/StopMarker.tsx` — NUEVO sub-componente
- `packages/ui/src/index.ts` — exports
- `apps/client/src/hooks/useRide.ts` (si existe función que llame createRide) — pasar waypoints
- `apps/web/src/app/track/TrackingMap.tsx` — mejorar markers web también (espejo de mobile)

## Progreso

### Fase A — ya existe en el código, saltar
Al explorar el código confirmé que `SelectingView` en `apps/client/app/(tabs)/index.tsx:2591-2612` **ya tiene** una sección de paradas con:
- `draft.waypoints` en `ride.store.ts` + `addWaypoint`/`removeWaypoint`/`updateWaypoint`
- Botón "+ Agregar parada (N/3)" (línea 2604) que dispara `addWaypoint()` + search input
- Lista con círculo naranja + número + remove (`Ionicons close-circle`)
- `createRide` en `useRide.ts:386-404` pasa `waypoints` al crear el ride

**Entonces la Fase A está cubierta**. Lo que el user ve "mal integrado" es:
1. Durante `in_progress` (RideActiveView) la UX es MUY inferior — emojis, preview hardcoded, no se puede eliminar parada pending, etc.
2. Los markers en el mapa son chicos y no se distinguen bien.

Refocus del trabajo: saltar Fase A, ir a B y C.

### Fase B
- [ ] Componente `<StopsEditor>` en packages/ui
- [ ] Componente `<StopMarker>` para iconos
- [ ] Reemplazar emojis en RouteSummary waypoints map
- [ ] Preview dinámico con `estimateWaypointAddition`
- [ ] Botón remove (`×`)
- [ ] Drag-to-reorder

### Fase C
- [ ] Markers altos (32-40px) con número grande
- [ ] Label con dirección trunca
- [ ] Pulse animation next-stop
- [ ] Estado completed (gris + check)
- [ ] Mismo polish en web (`TrackingMap`)

## Verificación final

Cuando esté todo:
1. Crear viaje → pickup → dropoff → agregar 2 paradas → ver preview real de fare/tiempo → confirmar ride.
2. Mapa muestra ruta pickup → parada1 → parada2 → dropoff con markers distintivos.
3. Durante `in_progress`: next-stop destacado con pulse; completadas en gris + check.
4. Reorder en pending: drag-and-drop funciona.
5. Remove: tap `×` quita parada, ruta recalcula.
6. Web share: mismo comportamiento visual.

## Decisiones explícitas

- **No permitir reorder durante `in_progress`** — la parada actual ya está comprometida al conductor; reordenar sería inconsistente.
- **No permitir eliminar parada ya visitada** — historia del viaje.
- **Max 3 paradas** — se mantiene el cap del backend (migración 00029).
- **Emojis afuera** — regla crítica del design system Cuban modern.

## Lenguaje visual Cuban Modern (NO genérico)

Todo el rediseño debe hablar en los tokens del Cuban Modern ya establecido en el home redesign. Nada de Material puro / Ionicons neutros / colores crudos.

**Tipografía por rol (decidida):**
- **Número de parada grande (dentro del marker / círculo)**: `Bricolage_700Bold` — la misma familia del DisplayHeading del home. Es el número que se ve grande.
- **Label "Parada 1" / "Parada 2"**: `JetBrainsMono_500Medium` — la mono sans de las caption labels (patrón "DESTINO" del home). Uppercase, letter-spacing 2.
- **Dirección trunca (2-3 palabras)**: `Montserrat_500Medium` — el body default del sistema.
- **Ninguna fuente Inter ni System default** — rompe el feel de marca.

**Color tokens (de `@tricigo/theme` cubanLight / cubanDark):**
- Naranja principal de paradas: `accent.orange` (`#FF4D00`)
- Glow naranja para next-stop (pulse): `accent.orangeGlow` (`rgba(255,77,0,0.18)`)
- Fondo de marker completed: `accent.dusk` (`#6B7F8F`) — el azul gris del Capitolio
- Fondo card de paradas: `bg.elev1` light / `bg.elev2` dark
- Línea divisoria: `line` (alpha del ink primary)

**Formas / espaciados:**
- BorderRadius `14` para cards de parada (misma curva de BalanceHeroCard y RecentPlacesList)
- BorderRadius `999` (píldora) para el marker/círculo
- Padding interno `14 16` en cards, gap `12` entre items
- Shadow `shadow.card` del token (no elevation Android cruda)

**Patrones reutilizables del home (hay que copiar, no inventar):**
- El patrón del `<RecentPlacesList>` (dot naranja con ring + info stack + chevron) es la fuente. Las paradas deben ser primas hermanas visualmente.
- El patrón del `<BalanceHeroCard>` usa el `orangeGlow` radial — copiarlo para el pulse del next-stop marker.
- El `<CapitolioDivider>` establece el uso de SVG inline con colores tokenizados — extender al caso de markers del mapa.

**Markers del mapa (v2):**
- SVG custom tipo "pin gota" 32×40px con:
  - Cuerpo naranja `#FF4D00` + borde blanco 2px
  - Número dentro en Bricolage 700 blanco 14pt
  - Triángulo inferior (punta del pin) con la misma naranja
- Next-stop: el mismo pin + ring pulsante exterior en `orangeGlow` (18% alpha), escala 1 → 1.6, 1.6s ease-out, infinite
- Completed: cuerpo `accent.dusk` + check SVG blanco en lugar de número
- Pending futura: el mismo pin en `accent.dusk` outline, sin fill

Nada de iconos "close-circle" Ionicons crudos para el remove. Hacer un SVG X custom con el trazo del design system (stroke-width 1.8, caps round).
