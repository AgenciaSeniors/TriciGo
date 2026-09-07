# Plan: mejorar mapa del cliente — búsqueda, pin y autocompletado

**Rama:** `claude/client-map-improvements-ocsopo` (hoy en la punta de `origin/master`, `0dfdbf3`)
**Fecha:** 2026-09-05
**Alcance:** `apps/client` (principal) + `packages/utils` + `packages/api` + `packages/types` + migración `00578` + display en `apps/driver` y `apps/admin` + paridad mínima de datos en `apps/web`.

---

## Contexto

El usuario pidió mejorar el mapa del pasajero en tres frentes: **búsqueda de direcciones**, **colocación del pin** y **autocompletación de datos**. Marcó los cuatro síntomas (el pin cae mal, la búsqueda no encuentra, hay que teclear demasiado, se siente torpe) y decidió: (a) detalles de dirección + **notas al conductor** guardadas en el viaje y visibles para conductor y admin, con Casa/Trabajo como lugares fijos con detalles; (b) **ambos**: selector de pin mejorado **y** marcadores arrastrables en el mapa principal; (c) sin ejemplos de búsquedas fallidas → medí contra producción.

Las tres "olas" del mapa de agosto (#971 puck/haptics/long-press, #972 animaciones, #973 lugares/3D) ya están en master. Este plan construye encima, no las toca.

### Lo que existe hoy (verificado en código)

- **Pin:** un solo mecanismo, arrastrar el mapa bajo un pin central fijo (`apps/client/src/components/ConfirmLocationScreen.tsx`). Entradas: "Elegir en el mapa", long-press, tap en lugar del mapa, y confirmación "¿El destino es aquí?" cuando el resultado es una calle (`meta.confirmPin`). Los marcadores del mapa de selección **no** son arrastrables (comentario explícito `RideMapView.tsx:1175-1178`). La barra muestra POI + `calle, municipio, provincia` en solo lectura; sin calle cerca muestra `"Cerro, La Habana"` sin avisar que es aproximado (`toDisplay`, línea 55) aunque `StructuredAddress.source` (`packages/utils/src/geo.ts:2223`) ya distingue `cross_streets|overpass|road|nearest_street|locality|poi_only`.
- **Búsqueda:** un cuadro único (`AddressSearchInput.tsx`, 1201 líneas) que fusiona Google + `search_pois_smart` + `search_streets` + esquinas `find_intersection_point` + guardadas/recientes/sugeridos. `parseCubanAddress` (`geo.ts:1875`) solo entiende `X e/ Y y Z` y `X entre Y y Z`.
- **Autocompletado:** el origen se rellena por GPS. No existe campo de número/apto/referencia/indicaciones; `rides` no tiene columna de notas. `SavedLocation` es `{label, address, latitude, longitude}` (`packages/types/src/user.ts:34`); "Casa"/"Trabajo" se infiere buscando la palabra en la etiqueta (`AddressSearchInput.tsx:1038`).

### Evidencia medida en producción (solo lectura, últimos 90 días, 207 viajes)

| Señal | Valor | Qué significa |
|---|---|---|
| Destinos que son una **zona pelada** ("Vedado, La Habana", "Cerro, La Habana", "Miramar, Playa") | **27 (13 %)** | Dos orígenes: pin sin calle a <200 m (capa `locality`) y resultados de zona de Google/Mapbox que se confirman sin pin porque `displayName ≠ address` los hace pasar por POI (`AddressSearchInput.tsx:726`). |
| Viajes con placeholder de UI ("Detectando dirección…", "Ubicación seleccionada en el mapa") | 8 | El backstop 00539/00546 los repara server-side, pero el conductor los vio en la oferta. |
| `find_intersection_point('23','12',NULL,…)` | resuelve "Calle 23 y Calle 12" ✓ | **El servidor ya entiende esquinas** "X y Y"; el cliente nunca lo llama porque el parser no reconoce esa forma. "23 y 12" hoy devuelve dos calles sin relación. |
| `search_streets` v9 / `search_pois_smart` | sanos (Infanta, San Lázaro, Obispo, Coppelia, Calixto García, aeropuerto) | El ranking no es el problema; los huecos son de **forma de entrada** y de **confirmación**. |
| Google Places cache hit-rate | 20-35 % | Deuda diferida documentada, fuera de alcance. |

### Huecos concretos del código (verificados)

1. Zona amplia se confirma sin pin (arriba). Además la rama **pickup** de `onSelect` ignora `meta.confirmPin` (`index.tsx:3618-3621`).
2. Esquinas "X y Y" / "X esq. Y" no se parsean.
3. Elegir una completación de esquina completa ("X e/ Y y Z") solo rellena el cuadro; hace falta un segundo tap (`handleSelectMerged`, 612-615).
4. "Sin resultados" puede parpadear antes de la primera respuesta (sin `hasSearchedRef`, canon de CLAUDE.md § "Cliente robustness pattern").
5. `useDestinationPredictions()` se llama **sin** `near` en móvil (`index.tsx:1970`, `:3120`) aunque el hook ya lo acepta (`useDestinationPredictions.ts:18-19`); `userCenterLatLng` se declara en `:3134`, después del hook.
6. `CreateRecurringRideSheet.tsx:133-145` usa el buscador sin guardadas/recientes/sugeridos. (`EditRecurringRideSheet` NO tiene buscador: muestra direcciones en solo lectura, `:106,110` — no se toca.)
7. Claves i18n ausentes en `es/rider.json` (renderizan por `defaultValue`, español fijo en en/pt): `ride.pick_on_map`, `ride.saved_locations`, `ride.recent_addresses`, `ride.suggestions`, `ride.add_stop_title`, `ride.add_stop_placeholder`, `ride.center_on_me`, `home.offline_results`, `home.searching_more`, `home.did_you_mean`.
8. `updateProfileSchema.saved_locations` usa `name` mientras la app manda `label` (`packages/api/src/schemas.ts:236-241`; sin bug vivo porque `customerService.updateProfile` no aplica el schema).
9. `rides` no tiene notas; el conductor lee `rides` con `select('*')` en todos los caminos (oferta `ride.service.ts:1319`, activo `driver.service.ts:723`, historial `:828`, detalle `ride.service.ts:775`) → dos columnas nuevas llegan solas. El push de oferta (`notify_driver_new_offer`, 00356:67-78) incluye `pickup_address` → **no** agregar notas ahí. `SharedRideView` se arma campo por campo (`ride.service.ts:1627`) → no fuga, pero se asserta en test.
10. Pin en el picker: `pickerSeed ⇒ sin initialAddress` es una regla deliberada (`index.tsx:1822-1832`, incidente 00537). Un botón "Ajustar en el mapa" necesita semilla **y** dirección → el estado del picker debe llevar un flag explícito, no inferirlo.
11. `RideMapView` re-ajusta los bounds cuando cambia `rideKey` (pickup+dropoff) (`RideMapView.tsx:708-728`) → tras un arrastre la cámara saltaría. Y está montado 3 veces (`index.tsx:3460` selección, `:4197` revisión, `:4989` viaje activo) → el arrastre debe ser opt-in por props.
12. `enforce_ride_update_columns` vivo = 00290 (ninguna migración posterior lo redefine). El literal `OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address THEN` aparece exactamente una vez (`00290:128`). Precedente reciente de `DO $patch$`: `00573_apply_osm_delta_generated_column_fix.sql:64-82`.

---

## Decisiones de diseño

- **Entrega: 4 PRs secuenciales sobre la rama designada** (`claude/client-map-improvements-ocsopo`), uno por frente. Tras cada squash-merge la rama se reinicia desde `origin/master` con el mismo nombre (regla del harness). Orden: PR-1 búsqueda (sin DB) → PR-2 pin (sin DB) → PR-3 notas + Casa/Trabajo (migración 00578) → PR-4 paridad web de datos. Cada merge requiere autorización explícita por PR (CLAUDE.md). Alternativa si el usuario prefiere no mergear de a uno: un solo PR con 4 commits separables, mismo contenido.
- **Migración `00578_ride_endpoint_notes.sql`**: pre-flight hecho contra `origin/master` (última `00577`) y PRs abiertos (#965 reserva `00569`; #843/#842/#840 sin migraciones). Re-chequear antes del push. No se aplica desde el sandbox (MCP guard): el cliente **tolera la columna ausente**.
- **Notas = una caja de texto por punto** (≤200 chars), no un formulario estructurado. Cubre número, apto, referencia e indicaciones con placeholder de ejemplo.
- **Marcadores arrastrables con `PointAnnotation draggable`** (API nativa `draggable/onDragStart/onDrag/onDragEnd(payload: Feature<Point>)`; el arrastre empieza con long-press sobre el marcador en Mapbox v11). Hijos estáticos (Android rasteriza a bitmap). El bounce del destino (BUG-307) se conserva con un **ghost swap**: `MarkerView` animado ~600 ms tras un cambio programático, luego el `PointAnnotation` estático.
- **Tras el arrastre se commitea la coordenada de inmediato** con la etiqueta previa (`setX(prevAddress, coord)`) — así el marcador no vuelve atrás y la estimación arranca ya — y el reverse geocode actualiza **solo la etiqueta** con una acción nueva del store que no limpia la tarifa. (Sin estado de override local.)
- **Zona amplia → confirmación obligatoria de pin**, misma pantalla que hoy usa `confirmPin`, con caption distinto; en **ambas** ramas (pickup y dropoff).
- **Indicador de confianza en el picker** derivado de `StructuredAddress.source`.
- **Web**: búsqueda y pin de la web son código separado y sin evidencia de fallo → fuera. Solo se lleva lo que es dato compartido (notas al crear viaje + `kind/details` en lugares guardados).
- **Antes de tocar `RideMapView`**: tras `pnpm install`, leer `node_modules/@rnmapbox/maps/lib/typescript/src/components/PointAnnotation.d.ts` y `MapView.d.ts` (`getPointInView`, `onCameraChanged`) y pegar las firmas en el PR body (como hizo la ola 1). El sandbox no tiene `node_modules` hoy; la doc confirma que existen.

---

## PR-1 — Búsqueda: esquinas, zonas amplias, un tap menos

**Archivos:** `packages/utils/src/geo.ts`, `packages/utils/src/addressSearch.ts` (+ tests en `packages/utils/src/__tests__/{geo,addressSearch}.test.ts`), `apps/client/src/components/AddressSearchInput.tsx`, `apps/client/app/(tabs)/index.tsx`, `apps/client/src/components/CreateRecurringRideSheet.tsx`, nuevo `apps/client/src/hooks/useSavedLocations.ts`, `packages/i18n/src/locales/{es,en,pt}/rider.json`.

### Tareas (TDD en cada helper puro)

1. **`parseCornerQuery(query)`** en `geo.ts` junto a `parseCubanAddress` → `{ main, cross1, strength: 'strong'|'weak' } | null`. Solo se evalúa si `parseCubanAddress` dio `null`. Guardas: exactamente un separador (`\s+y\s+` | `\s+esq(?:\.|uina)?\s+(?:a\s+)?`); rechazar si hay ` e/ `, ` entre `, coma o >60 chars; cada lado 1-3 tokens no vacíos; stop-list de nombres comerciales (`pan|tacos|cafe|pizza|ron|sol|mar|mas|cia|hnos|hijos|co`) y rechazo si la query empieza por `restaurante|bar|cafeteria|hotel|paladar|pizzeria|panaderia|tienda|farmacia|casa de`. `strong` si algún lado es "de cuadrícula" (`^\d{1,3}[a-z]?$`, ordinal `^\d{1,2}(ra|da|ta|ma|va|na|ª|°)$`, letra sola `^[a-p]$`, o empieza por `calle|calzada|avenida|av\.?|linea|paseo`). Casos: `23 y 12`, `5ta y 42`, `Línea esq. a G`, `23 esquina 12` → strong; `Infanta y San Lázaro` → weak; `Pan y Canela`, `Tacos y Más`, `23 y 12 y 14` → null; `Reina entre Campanario y Lealtad` → null (lo toma `parseCubanAddress`). El parser es pre-filtro barato: la verdad la da `find_intersection_point` devolviendo null.
2. **`isZoneLevelResult(r)`** + penalización en `addressSearch.ts`. `false` salvo `source ∈ {google, searchbox, mapbox}`. Google (`matchedCategory` = `types[0]`, `search-places-google/_shared/google.ts:267`): `locality, sublocality, sublocality_level_1..5, neighborhood, political, administrative_area_level_1..7, postal_code, country, colloquial_area`. Mapbox (`category`, `geo.ts:3221-3224`): `place, locality, neighborhood, district, region, postcode, country`. Fallback solo si ambas categorías están vacías: `place_name` (sin tildes) coincide con un `label` de `ALL_PRESETS` (`geo.ts:62`) **y** `address` tiene ≤2 segmentos por coma. Constante exportada `ZONE_LEVEL_CATEGORIES` espejo de `PROVIDER_STREET_CATEGORIES` (`:125-127`). `scoreSearchResult` (`:237`) resta `0.35` a filas de zona (`ScorableResult` gana `matchedCategory/category/address` opcionales). Casos: Google `sublocality_level_1` → true; Google `restaurant` → false; Mapbox `neighborhood` → true; `source:'supabase', category:'locality'` → false; sin categoría + `place_name:'Vedado'`/`address:'Vedado, La Habana'` → true; `place_name:'Hotel Vedado'` → false; `rankSearchResults` pone la zona debajo de un POI a la misma distancia.
3. **Pipeline en `AddressSearchInput.tsx`:** `AddressSearchResult` (`geo.ts:621-669`) gana `zoneLike?: boolean`; `normalize()` (`:313-320`) lo setea. Esquina: tras el bloque `cubanParsed` (`:269-286`), si `parseCornerQuery(text)` matchea, agregar `lookupIntersectionPoint(main, cross1, undefined, userLocation)` (`geo.ts:1798`) como **cuarto miembro del `Promise.all`** (`:320-328`); si resuelve, **anteponer** `{address, displayName: address, lat, lng, category:'street'}` antes del cap (`:371`) y dedupear ≤100 m contra `streetResults` para que las dos calles sueltas de "23 y 12" no sobrevivan. Nunca corto-circuito. Un tap: en `handleSelectMerged` (`:612-615`), si `needsResolution` y `parseCubanAddress(item.address)` es completo, resolver con `lookupIntersectionPoint` y seguir el commit normal con `{ confirmPin: true }`; si falla, comportamiento actual. `mergedResults` (`:708-730`) pasa `zoneLike`; `confirmPin = !!item.streetLike || !!item.zoneLike` (`:633`) y meta gana `zoneLike` (también en `handleSelect` `:473-477`). Filas de zona muestran caption "Zona amplia — te pediremos ajustar el pin" (`ride.zone_caption`). `hasSearchedRef`: `true` en el cuerpo del debounce antes de `setIsSearching(false)`, **también en cache-hit y en `gridOnly`**; reset con query vacía; gatea el empty state (`:956`). Tipo del meta de `onSelect` (`:84`): `{ confirmPin?; zoneLike?; notes? }` (`notes` lo usa PR-3).
4. **Callers:** `index.tsx:3120` → `useDestinationPredictions(userCenterLatLng)` (mover el memo de `:3134` arriba del hook); `:1970` → `{latitude: userCenter[1], longitude: userCenter[0]}` memoizado. `onSelect` (`:3618-3640`): la rama **pickup** también honra `confirmPin` (abre el picker con `target: 'pickup'`); guardar `zoneHint` en estado hermano hasta que PR-2 generalice el picker. `CreateRecurringRideSheet.tsx:133-145`: pasar `savedLocations` (extraer el loader de `index.tsx:3386-3396` a `useSavedLocations`), `recentAddresses` (`useRecentAddresses`) y `predictions` (`useDestinationPredictions(near)`).
5. **i18n** es/en/pt: las 10 claves faltantes + `ride.zone_caption`.

### Verificación PR-1
`pnpm --filter @tricigo/utils test` · `pnpm check-types` · `pnpm check:i18n` · `pnpm --filter client lint` (≤66 warnings, 0 errors). Smoke prod (solo lectura): `find_intersection_point('23','12',NULL,23.1357,-82.3666,8000)` = "Calle 23 y Calle 12". En celu: "23 y 12" → primer resultado la esquina; "Vedado" de Google → picker con caption de zona; "Pan y Canela" sigue mostrando el POI.

**Riesgos:** regex de esquina sobre-matcheando (acotado por el null de la RPC, costo 1 RPC de ~5 ms); fila antepuesta sobreviviendo dos veces al dedupe (test con "23 y 12"); `hasSearchedRef` sin setear en cache-hit/`gridOnly` → el empty state nunca aparece.

---

## PR-2 — Pin: selector más preciso y marcadores arrastrables

**Archivos:** nuevo `packages/utils/src/mapPicker.ts` (+ export en `index.ts`, tests), `apps/client/src/components/ConfirmLocationScreen.tsx`, `apps/client/src/components/RideMapView.tsx`, `apps/client/app/(tabs)/index.tsx` (`NativeHomeScreen` + `SelectingView`), `apps/client/src/stores/ride.store.ts`, i18n rider.

### Tareas

1. **Helpers puros `mapPicker.ts`:** `pinConfidence(source | null): 'exact'|'near'|'none'` (`cross_streets|overpass|road` → exact; `nearest_street` → near; `locality|poi_only|null` → none); `pickerZoomFor(seeded: boolean): 15|17`; `isNearScreenPoint(p, markers: Array<{x,y}|null>, radiusPx=40)`; `coordsEqual(a, b, eps=1e-6)`. Tests: una rama por valor + null/vacíos.
2. **`ConfirmLocationScreen.tsx`:** props nuevas `seeded?: boolean` (`zoomLevel: pickerZoomFor(seeded)` en `:384`), `counterpart?: { location: GeoPoint; mode } | null` (`MarkerView` estático `pointerEvents="none"` con los assets de `RideMapView`, para orientación), `confirmHint?: 'zone' | null`. Guardar `result?.source` junto a `display` en `geocodeCenter` (`:124-180`); caption de confianza bajo la dirección (`:492-522`): exact → "Dirección exacta ✓" (`ride.pin_exact`), near → sin caption, none → ⚠ "Sin calle cercana — acerca el pin a una calle" (`ride.pin_no_street`); `confirmHint === 'zone'` reemplaza el caption del header (`:492-496`) por `ride.zone_adjust_prompt` ("Es una zona amplia — ajusta el pin al lugar exacto"). **Lift:** `onCameraChanged` → `setLifted(true)` (guardado por ref: dispara por frame), `handleMapIdle` (`:189`) → `setLifted(false)`; pin `translateY 0→-10` y sombra `scaleX 1→0.6`, `useNativeDriver`, 120 ms. Confirmar **no** se bloquea (`:241-293`); con `none` el botón dice "Confirmar de todos modos" (`ride.confirm_anyway`).
3. **`RideMapView.tsx` arrastre (opt-in):** props `onPickupDragEnd?/onDropoffDragEnd?: (lng, lat) => void`; `draggable={!!onXDragEnd}`; solo `SelectingView` las pasa (revisión y viaje activo no). Pickup: el `PointAnnotation` existente (`~1130-1153`) gana `draggable` + handlers. Dropoff: **ghost swap** — al cambiar `dropoffLocation` por un valor distinto de `lastDragCoordRef` (`coordsEqual`) se renderiza el `MarkerView` animado (`:1179-1210`) durante 600 ms con el `PointAnnotation` estático debajo a opacidad 0, ambos keyed por coordenada; al vencer el timer queda solo la anotación; cambio originado por arrastre → sin ghost; limpiar timer al desmontar. `onDragEnd(payload)` → `[lng, lat] = payload.geometry.coordinates` → **escribir la nueva `rideKey` en `lastFitRideKey.current` antes de llamar al padre** (evita el salto de cámara del re-fit `:708-728`) → `triggerHaptic('light')` → callback. Conflicto de gestos: `onDragStart` marca `draggingRef`; `onLongPress` (`:922-929`) sale temprano si `draggingRef` o `isNearScreenPoint(screenPoint, await getPointInView(pickup/dropoff))` (calcular antes del haptic). Sin `refresh()` salvo un effect keyed en `isDark` (tint del asset). Reescribir el comentario `:1175-1178`.
4. **Estado del picker generalizado en `NativeHomeScreen`:** reemplazar `mapPickerMode` (`:1756`) + `pickerSeed` (`:1760`) por `PickerState = { target: 'pickup'|'dropoff'|'waypoint'; confirm: boolean; seed?: GeoPoint; keepAddress: boolean; zoneHint?: boolean } | null`. Montaje (`:1820-1848`): `initialAddress` solo si `keepAddress`; `seeded={!!seed || keepAddress}`; `confirmHint={zoneHint ? 'zone' : null}`; `counterpart` = el otro extremo del draft. Long-press / tap-POI (`openPickerAt`, `:1855`) → `keepAddress: false`; confirmación desde búsqueda y "Ajustar" → `true`. El effect de cierre forzado (BUG-253, `:1766-1774`) sigue funcionando con `!== null`. Unificar los cuatro puntos de entrada.
5. **"Ajustar en el mapa" en las filas compactas** (`:3561-3575`): icono `map-outline` (44 px) por fila, oculto si el extremo está vacío → `setPicker({ target, confirm:false, seed: draft[target].location, keepAddress:true })`.
6. **Arrastre en `SelectingView`:** `handleDragEnd(target)(lng, lat)` → `setPickup/setDropoff(draft[target].address, {latitude, longitude})` **inmediato** (mantiene etiqueta, dispara re-estimación `:3420-3425` y `suggestPickupPoint` `:3332-3342`) → `setAdjusting(target)` → `Promise.race([reverseGeocode, 3 s])` → fallback `findNearestPreset` "Cerca de X" o coords (espejo de `ConfirmLocationScreen.tsx:281-291`, nunca placeholder) → **acción nueva del store `setEndpointAddress(target, address)`** que actualiza solo `address` sin limpiar `fareEstimate` → `setAdjusting(null)`. Mientras tanto la fila muestra la etiqueta previa + caption "Ajustando…" (`ride.adjusting`). Hint una vez por sesión bajo el mapa: "Mantén presionado el pin para moverlo" (`map.drag_hint`).

**i18n:** `ride.pin_exact`, `ride.pin_no_street`, `ride.zone_adjust_prompt`, `ride.confirm_anyway`, `ride.adjust_on_map`, `ride.adjusting`, `map.drag_hint`.

### Verificación PR-2
Tests puros verdes · `pnpm check-types` · `pnpm check:i18n` · `pnpm --filter client lint`. Sin módulo nativo nuevo → no requiere rebuild de APK, sí dev client conectado a Metro con esta rama. En celu (Android **y** iOS): abrir picker desde búsqueda → zoom 17 + caption de confianza; mover el mapa → el pin se levanta y baja; long-press sobre el marcador de destino y arrastrar → "Ajustando…", luego la nueva dirección, la tarifa se re-estima, la cámara **no** salta; long-press en zona vacía sigue abriendo el picker; el bounce del destino sigue al elegir desde búsqueda; nada es arrastrable en revisión ni en viaje activo.

**Riesgos:** `getPointInView` desfasado mientras la cámara anima (los 40 px son generosos); snapshot Android mostrando el marcador pre-arrastre (hijos estáticos); timer del ghost solapado con una segunda selección (keyed por coordenada).

---

## PR-3 — Notas al conductor + Casa/Trabajo con detalles (migración 00578)

**Archivos:** `supabase/migrations/00578_ride_endpoint_notes.sql`; `packages/types/src/{ride,user}.ts`; `packages/api/src/schemas.ts`, `packages/api/src/services/ride.service.ts` (+ tests `packages/api/src/services/__tests__/ride.test.ts`, `customer.test.ts`); nuevos `packages/utils/src/addressNotes.ts`, `packages/utils/src/savedPlaces.ts` (+ tests); `apps/client/src/stores/ride.store.ts`, `apps/client/src/hooks/useRide.ts`, `apps/client/app/(tabs)/index.tsx`, nuevo `apps/client/src/components/AddressDetailsSheet.tsx`, `apps/client/src/components/AddressSearchInput.tsx`, `apps/client/src/services/recentAddresses.ts` (+ test), `apps/client/src/hooks/useRecentAddresses.ts`, `apps/client/app/profile/saved-locations.tsx`, `packages/ui/src/RouteSummary.tsx`; `apps/driver/src/components/DriverTripView.tsx`, `apps/driver/src/components/trip/RouteInfoCard.tsx`; `apps/admin/src/app/rides/[id]/page.tsx`; i18n rider/driver/admin/common es/en/pt.

### Migración `00578_ride_endpoint_notes.sql`
Pre-flight antes de escribir **y** antes del push (`git ls-tree origin/master supabase/migrations/ | sort -r | head -5` + `files` de cada PR abierto). Cuerpo:
```sql
ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS pickup_notes  text,
  ADD COLUMN IF NOT EXISTS dropoff_notes text;
-- CHECK ≤200 chars, idempotente (DO block con lookup en pg_constraint):
--   rides_pickup_notes_len / rides_dropoff_notes_len
COMMENT ON COLUMN public.rides.pickup_notes IS '00578: nota del pasajero para el conductor en la recogida (apto, edificio, timbre). NO va en pushes ni en SharedRideView.';
-- (ídem dropoff_notes)
DO $patch$
DECLARE v_src text; v_n int;
  c_target CONSTANT text := 'OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address THEN';
  c_repl   CONSTANT text := 'OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address
       OR NEW.pickup_notes IS DISTINCT FROM OLD.pickup_notes
       OR NEW.dropoff_notes IS DISTINCT FROM OLD.dropoff_notes THEN';
BEGIN
  SELECT pg_get_functiondef('public.enforce_ride_update_columns()'::regprocedure) INTO v_src;
  IF position('NEW.pickup_notes' IN v_src) > 0 THEN RAISE NOTICE '00578: already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_target, ''))) / length(c_target);
  IF v_n <> 1 THEN RAISE EXCEPTION '00578: target literal found % times, expected 1', v_n; END IF;
  EXECUTE replace(v_src, c_target, c_repl);
EXCEPTION WHEN undefined_function THEN RAISE NOTICE '00578: enforce_ride_update_columns absent; skipping';
END $patch$;
```
`notify_driver_new_offer` (00356) intacto. PR body: "Migración no aplicada a prod (MCP guard); el frontend tolera ausencia."

### Tareas
1. **Tipos/schemas:** `Ride.pickup_notes?/dropoff_notes?: string | null` (`ride.ts:71-73`); `SavedLocation.kind?: 'home'|'work'|'other'`, `details?: string`; `RecentAddress.notes?: string`. `createRideSchema` (`schemas.ts:44-103`): ambos `z.string().trim().max(200).optional().nullable()`; `updateProfileSchema.saved_locations`: `name`→`label` + `kind` enum + `details` (≤200). `CreateRideParams` (`ride.service.ts:~80-115`).
2. **`ride.service.createRide`** (`:470-508`): incluir notas; extraer `insertRideRow` que ante `error.code === 'PGRST204'` **cuyo mensaje nombre `pickup_notes`/`dropoff_notes`** borra ambas claves, `console.warn('[rideService] rides.*_notes column missing (00578 not applied) — retrying without notes')` y reintenta una vez; otras columnas ausentes siguen fallando. Tests (`ride.test.ts`, mock shape `:702-707`): notas reenviadas; primer insert PGRST204 → segundo payload sin las claves; nota de 201 chars → `ValidationError`; `getPublicRideByShareToken` sin `pickup_notes`. `customer.test.ts`: schema acepta `{label, kind:'home', details}` y rechaza `{name}`.
3. **Helpers puros:** `trimNotes(s)` en `addressNotes.ts` (vacío → null, colapsa espacios, cap 200, conserva saltos) y `resolveFixedPlaces(saved)` en `savedPlaces.ts` → `{ home?, work?, others }` (`kind` primero, luego heurística de etiqueta para filas legacy; duplicados → gana el primero). Tests: vacío/solo espacios/201 chars; kind gana sobre label; fallback "Casa"/"Trabajo"; ninguno → undefined.
4. **Store:** `LocationDraft.notes?: string`; `setPickup/setDropoff(address, location, notes?)` (sin `notes` = se limpia en una selección nueva, documentar en call sites); `setPickupNotes/setDropoffNotes(notes)` sin tocar `fareEstimate`; `swapPickupDropoff` (`:475-480`) ya intercambia objetos enteros.
5. **UI cliente:** `AddressDetailsSheet` (`BottomSheet` + `Input` multilínea, contador 200, placeholder "Ej: #302 apto 4, edificio azul, tocar el timbre", props `{ visible, target, address, value, onSave, onClose }`); link "Agregar detalles" / "Detalles: …" bajo cada fila compacta de `SelectingView`; en `ReviewingView` (`:4404-4413`) notas bajo `RouteSummary` (props opcionales `pickupNote/dropoffNote` en `packages/ui/src/RouteSummary.tsx:5-12`) con edición. Payload en `useRide.ts:793-866` (`trimNotes`) y en `index.tsx:950-992` (leer del store).
6. **Casa/Trabajo:** filas fijas al tope del panel idle de `AddressSearchInput` vía `resolveFixedPlaces` (reemplaza la inferencia por texto `:1038`); existentes → `onSelect(..., { notes: loc.details })`; ausentes → "Agregar casa/trabajo" → `router.push('/profile/saved-locations?kind=home')`. `saved-locations.tsx`: `useLocalSearchParams<{kind?}>()` (precedente `apps/client/app/gift/[code].tsx:12`) abre la hoja al montar con etiqueta fija y `kind`; la hoja (`:266-346`) gana `details`; `handleSave` (`:86-118`) persiste `kind/details`. `index.tsx` `onSelect` reenvía `meta?.notes` a `setPickup/setDropoff`.
7. **Recientes con notas:** `recentAddressService.add(address, lat, lng, notes?)`; `useRide.ts:908-909` pasa las notas; re-selección restaura (`{ notes: r.notes }`); tarjeta "TU ÚLTIMO VIAJE" prefill desde `ride.pickup_notes/dropoff_notes`. Tests en `recentAddresses.test.ts`: guarda, omite si undefined, dedupe conserva las más nuevas.
8. **Conductor:** `DriverTripView.tsx:891-893` `secondaryNote` espejo de `secondaryAddress`, render bajo la dirección (`:907-922`) con `chatbubble-ellipses-outline` y tinte warning como `DeliveryDetailsCard.tsx:174-205`, `numberOfLines={2}`; `RouteInfoCard` (`:17-24`) props `pickupNotes?/dropoffNotes?` bajo cada dirección (`:136-141`, `:191-196`), pasadas desde `:1138-1143`. `IncomingRideCard` **sin cambios**. `driver.json` `trip.rider_note`.
9. **Admin:** filas condicionales en `rides/[id]/page.tsx:210-217`; `admin.json` `rides.label_pickup_notes/label_dropoff_notes`.
10. **i18n:** `ride.add_details`, `ride.details_title`, `ride.details_placeholder`, `ride.details_hint`, `ride.home`, `ride.work`, `ride.add_home`, `ride.add_work`; `profile.location_details` (common).

### Verificación PR-3
Ensayo de la migración en Postgres local del sandbox (CLAUDE.md § "Cómo probar migraciones SQL de verdad": usuario `pgtest`, andamio con `rides` + `enforce_ride_update_columns` transcrita de `pg_get_functiondef` **vivo**) → el patch aplica, es idempotente y un UPDATE como conductor a `pickup_notes` lanza `driver cannot modify pickup/dropoff`. `pnpm --filter @tricigo/utils test` · `pnpm --filter @tricigo/api test` · `pnpm --filter client test` · `pnpm check-types` (4 apps) · `pnpm check:i18n` · lint. Manual: pedir viaje con notas **sin** 00578 aplicada → el insert reintenta sin notas y aparece un solo warn; **con** 00578 (aplicación humana/pipeline) el conductor ve la nota en el hero (requiere rebuild del APK conductor; decirlo en el PR body). Control: `SELECT pickup_notes, dropoff_notes FROM rides ORDER BY created_at DESC LIMIT 3`.

---

## PR-4 — Paridad web mínima (datos compartidos)

- `apps/web/src/app/book/page.tsx:818-830`: dos inputs opcionales → `pickup_notes/dropoff_notes` (schema y service ya los aceptan).
- `apps/web/src/app/profile/saved-locations/page.tsx:19-25,72-80,180-186`: interfaz local con `kind/details`, campos en el formulario, `getIcon` prefiere `kind`; `apps/web/src/components/AddressAutocomplete.tsx:55-60` misma regla de icono.
- `apps/web/src/app/rides/[id]/page.tsx`: mostrar notas.
- Verificación: `pnpm check-types`, lint web.

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Arrastre vs. paneo/long-press del mapa | Arrastre nativo requiere long-press sobre el marcador; `onLongPress` ignora presses a <40 px de un marcador y durante un drag; prueba en Android e iOS con pulgares reales (el usuario). |
| `PointAnnotation` rasteriza hijos en Android | Hijos estáticos; el bounce va en un `MarkerView` ghost temporal. |
| Cámara salta tras arrastrar | `lastFitRideKey` se actualiza antes de notificar al padre. |
| Falso positivo de esquina ("Pan y Canela") | La esquina corre en paralelo y solo se antepone si el servidor la resuelve; el POI sigue apareciendo. |
| Migración no aplicada cuando el APK ya manda notas | Retry sin notas ante `PGRST204` que nombre la columna; documentado en el PR body. |
| Un conductor edita notas | Rama deny del trigger extendida en 00578 (literal único verificado). |
| Fuga de notas | No se agregan al push de oferta ni a `SharedRideView`/RPCs de share; no se renderizan en la tarjeta de oferta; test lo asserta. |
| Número de migración chocado por un PR paralelo | Re-correr el pre-flight antes del push. |

## Verificación global (antes de cada PR)
`pnpm install` (worktree fresco; luego `git checkout HEAD -- pnpm-lock.yaml`) · `pnpm check-types` · `pnpm --filter @tricigo/utils test` · `pnpm --filter @tricigo/api test` · `pnpm --filter client test` · `pnpm --filter client lint` · `pnpm check:i18n`. Pruebas en dispositivo las hace el usuario (capturas), según convención del proyecto. Cada PR responde el checklist de paridad de CLAUDE.md en su body (web: PR-4; driver: PR-3; admin: PR-3).
