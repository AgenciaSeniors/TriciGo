# Map wave 3 — "the map has a world" implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put places and buildings on the map, and let the rider pick a destination by touching one — without changing the base style, because that would silently break offline maps.

**Architecture:** Everything is drawn from `composite`, the vector source the app already downloads. New layers, not a new style. The detail toggle follows the driver app's existing simple-map precedent, and offline packs learn to record which style they hold so a future style change can't strand them.

**Tech stack:** `@rnmapbox/maps` ~10.3 (Mapbox Maps SDK **11.18.2**), Expo SDK 55, RN 0.83, TypeScript strict, vitest.

**Spec:** [docs/superpowers/specs/2026-08-20-client-map-liveliness-design.md](../specs/2026-08-20-client-map-liveliness-design.md)

---

## Verified facts (read from source — do not re-derive)

- Native SDK is **Mapbox 11.18.2** on both platforms (`node_modules/@rnmapbox/maps/package.json:77-78`), and the podspec aborts on v10 or on the old RN architecture.
- `SymbolLayer` and `FillExtrusionLayer` both accept `sourceID` and `sourceLayerID`, so a layer can bind to the style's own `composite` source without declaring a source of our own.
- `MapView.onPress` delivers `GeoJSON.Feature<Point, ScreenPointPayload>` where `ScreenPointPayload = { screenPointX: number; screenPointY: number }` (`MapView.d.ts:22-25, :243`).
- `queryRenderedFeaturesAtPoint(coordinate, filter?, layerIDs?)` takes **screen pixels**, not lng/lat (`MapView.d.ts:461-466`).
- `fillExtrusionOpacity` is **not** data-driven (zoom only); `fillExtrusionColor`, `fillExtrusionHeight` and `fillExtrusionBase` are (`MapboxStyles.d.ts:1409-1462`).
- There is **no** `StyleURL.Standard` constant and no `lightPreset` / `show3dObjects` support in the binding (grep: 0 hits). `StyleImport` exists but is undocumented in-package and mistypes `config` as string-only. Not used by this plan.
- Offline packs today store `{tiles, lastUsedAt}` only (`packages/utils/src/offlineRegion.ts:34-37`); `ensurePack` returns early on a name match (`useDynamicOfflineMap.ts:82-87`) and nothing ever compares style. `invalidatePack` exists in the SDK and is unused anywhere in the repo.
- The client's settings screen is `apps/client/app/profile/settings.tsx`; rows are `ProfileRow` (`apps/client/src/components/profile/ProfileRow.tsx:30`) with a `right` slot that already carries `Switch`es. `notificationsEnabled` (key `@tricigo/notifications_enabled`) is the AsyncStorage precedent.
- The driver's precedent for a map-density toggle is `driver_simple_map_mode` (`apps/driver/app/(tabs)/index.tsx:708-726`): read on mount, written as `'1'`/`'0'`, and it only suppresses visual layers — data hooks keep running.

---

## Task 1: Teach offline packs which style they hold

Pure logic first. This is the piece that makes any future style change survivable, and it has to land before anything else touches the map.

**Files:**
- Modify: `packages/utils/src/offlineRegion.ts`
- Modify: `apps/client/src/hooks/useDynamicOfflineMap.ts`
- Test: `packages/utils/src/__tests__/offlineRegion.test.ts` (exists — add to it)

- [ ] **Step 1: Write the failing test**

Append to `packages/utils/src/__tests__/offlineRegion.test.ts`:

```ts
describe('packNeedsRefresh', () => {
  const STYLE = 'mapbox://styles/mapbox/light-v11';

  it('refreshes a pack downloaded for a different style', () => {
    expect(packNeedsRefresh({ tiles: 100, lastUsedAt: 0, styleURL: 'mapbox://styles/mapbox/streets-v12' }, STYLE)).toBe(true);
  });

  it('keeps a pack that matches the current style', () => {
    expect(packNeedsRefresh({ tiles: 100, lastUsedAt: 0, styleURL: STYLE }, STYLE)).toBe(false);
  });

  // Packs downloaded before this field existed. One refresh brings them
  // under management; assuming they match would keep them stale forever.
  it('refreshes a legacy pack that never recorded its style', () => {
    expect(packNeedsRefresh({ tiles: 100, lastUsedAt: 0 }, STYLE)).toBe(true);
  });

  it('refreshes when there is no metadata at all', () => {
    expect(packNeedsRefresh(undefined, STYLE)).toBe(true);
  });
});
```

Add `packNeedsRefresh` to the import at the top of that test file.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @tricigo/utils test -- offlineRegion`
Expected: FAIL — `packNeedsRefresh is not a function` (or an import error).

- [ ] **Step 3: Implement**

In `packages/utils/src/offlineRegion.ts`, extend the metadata type with an optional field (optional so existing stored JSON still parses):

```ts
  /** Style the pack's tiles were downloaded for. Absent on packs created
   *  before this was recorded — treated as unknown, therefore stale. */
  styleURL?: string;
```

Then add:

```ts
/**
 * Whether a cached pack has to be thrown away and downloaded again.
 *
 * Tiles are style-specific. Without this check a style change leaves every
 * pack orphaned — still on disk, still counted against the tile budget,
 * silently serving the wrong style's data — because `ensurePack` reuses a
 * pack by cell key alone and never looks further.
 */
export function packNeedsRefresh(
  meta: OfflinePackMeta | undefined,
  currentStyleURL: string,
): boolean {
  if (!meta) return true;
  return meta.styleURL !== currentStyleURL;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @tricigo/utils test -- offlineRegion`
Expected: PASS, including the 4 new cases.

- [ ] **Step 5: Use it where packs are reused**

In `apps/client/src/hooks/useDynamicOfflineMap.ts`, this block currently reuses any pack whose name matches:

```ts
  const existing = await MapboxGL.offlineManager.getPack(region.cellKey).catch(() => null);
  if (existing) {
    meta[region.cellKey] = { tiles: meta[region.cellKey]?.tiles ?? 0, lastUsedAt: now };
    await saveMeta(meta);
    return;
  }
```

Replace it with:

```ts
  const existing = await MapboxGL.offlineManager.getPack(region.cellKey).catch(() => null);
  if (existing) {
    if (!packNeedsRefresh(meta[region.cellKey], MAP_STYLE_LIGHT)) {
      meta[region.cellKey] = {
        tiles: meta[region.cellKey]?.tiles ?? 0,
        lastUsedAt: now,
        styleURL: MAP_STYLE_LIGHT,
      };
      await saveMeta(meta);
      return;
    }
    // Downloaded for a different style: these tiles are the wrong data.
    // Falling through re-downloads them for the style in use now.
    if (__DEV__) console.log('[OfflineMap] style changed — refreshing pack', region.cellKey);
    await MapboxGL.offlineManager.deletePack(region.cellKey).catch(() => {});
    delete meta[region.cellKey];
  }
```

Then record the style where metadata is written after `createPack` — the line currently reads `meta[region.cellKey] = { tiles, lastUsedAt: now };`:

```ts
  meta[region.cellKey] = { tiles, lastUsedAt: now, styleURL: MAP_STYLE_LIGHT };
```

Import `packNeedsRefresh` from `@tricigo/utils`.

- [ ] **Step 6: Verify**

Run: `pnpm check-types` → `Tasks: 10 successful, 10 total`
Run: `pnpm --filter @tricigo/utils test` → all green

- [ ] **Step 7: Commit**

```bash
git add packages/utils apps/client/src/hooks/useDynamicOfflineMap.ts
git commit -m "fix(client): offline packs remember which style they hold"
```

---

## Task 2: Draw places worth travelling to

**Files:**
- Create: `packages/utils/src/mapPoiLayer.ts`
- Modify: `packages/utils/src/index.ts`
- Modify: `apps/client/src/components/RideMapView.tsx`
- Test: `packages/utils/src/__tests__/mapPoiLayer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { POI_LAYER_ID, POI_SOURCE_ID, POI_SOURCE_LAYER, poiFilter, poiNameFromFeature } from '../mapPoiLayer';

describe('poi layer constants', () => {
  it('binds to the style source the tiles already carry', () => {
    expect(POI_SOURCE_ID).toBe('composite');
    expect(POI_SOURCE_LAYER).toBe('poi_label');
  });

  it('uses an id of our own so taps can be filtered to it', () => {
    expect(POI_LAYER_ID).toBe('tricigo-places');
  });
});

describe('poiFilter', () => {
  it('is a Mapbox filter expression limited to travel-worthy classes', () => {
    expect(Array.isArray(poiFilter)).toBe(true);
    expect(poiFilter[0]).toBe('match');
    const classes = poiFilter[2] as string[];
    expect(classes).toContain('hospital');
    expect(classes).toContain('food_and_drink');
    expect(classes).toContain('lodging');
  });
});

describe('poiNameFromFeature', () => {
  it('reads the localized name when the tile has one', () => {
    expect(poiNameFromFeature({ properties: { name_es: 'Farmacia', name: 'Pharmacy' } })).toBe('Farmacia');
  });

  it('falls back to the neutral name', () => {
    expect(poiNameFromFeature({ properties: { name: 'Pharmacy' } })).toBe('Pharmacy');
  });

  it('returns null rather than an empty label', () => {
    expect(poiNameFromFeature({ properties: {} })).toBe(null);
    expect(poiNameFromFeature({ properties: { name: '   ' } })).toBe(null);
    expect(poiNameFromFeature(undefined)).toBe(null);
    expect(poiNameFromFeature({})).toBe(null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @tricigo/utils test -- mapPoiLayer`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

Create `packages/utils/src/mapPoiLayer.ts`:

```ts
/**
 * Places drawn as our own layer over the style's existing vector source.
 *
 * The base style hides most points of interest on purpose, and swapping the
 * style to reveal them would orphan every offline pack. The data is already
 * inside the tiles the app downloads, so we draw it ourselves — which also
 * means we choose what a rider actually needs to see instead of inheriting
 * a stock style's idea of a busy map.
 */

/** The style's own vector source. Present in every Mapbox Streets style. */
export const POI_SOURCE_ID = 'composite';
/** Mapbox Streets v8 layer holding points of interest. */
export const POI_SOURCE_LAYER = 'poi_label';
/** Ours, so taps can be queried against this layer alone. */
export const POI_LAYER_ID = 'tricigo-places';

/**
 * Classes worth showing to someone deciding where to go. Deliberately short:
 * every extra class is more clutter competing with the pickup and dropoff
 * pins, which are the only things on this map that must never be missed.
 */
export const POI_CLASSES = [
  'hospital',
  'pharmacy',
  'food_and_drink',
  'lodging',
  'school',
  'bank',
  'fuel',
  'grocery',
  'park',
  'place_of_worship',
] as const;

/** Mapbox filter expression: keep only the classes above. */
export const poiFilter: unknown[] = [
  'match',
  ['get', 'class'],
  [...POI_CLASSES],
  true,
  false,
];

interface FeatureLike {
  properties?: Record<string, unknown> | null;
}

/**
 * A place's display name, preferring Spanish where the tile carries it.
 * Returns null for unnamed or blank features so callers can skip them
 * rather than showing an empty bubble.
 */
export function poiNameFromFeature(feature: FeatureLike | undefined | null): string | null {
  const props = feature?.properties;
  if (!props) return null;
  for (const key of ['name_es', 'name']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}
```

Export from `packages/utils/src/index.ts`, after the `animateVehicles` exports:

```ts
export { POI_SOURCE_ID, POI_SOURCE_LAYER, POI_LAYER_ID, POI_CLASSES, poiFilter, poiNameFromFeature } from './mapPoiLayer';
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @tricigo/utils test -- mapPoiLayer`
Expected: PASS, 8 tests.

- [ ] **Step 5: Draw the layer**

In `RideMapView.tsx`, add the constants to the `@tricigo/utils` import, then place the layer **below** our own markers so pins always win — insert it immediately after the `<MapboxGL.Camera />` and the `LocationPuck`, before the route layers:

```tsx
        {/* Places, drawn from the data already inside the downloaded tiles.
            Icons only: the name appears on tap, so the map stays readable
            and we avoid map-layer text entirely. */}
        {showPlaces && (
          <MapboxGL.SymbolLayer
            id={POI_LAYER_ID}
            sourceID={POI_SOURCE_ID}
            sourceLayerID={POI_SOURCE_LAYER}
            minZoomLevel={14}
            filter={poiFilter as never}
            style={{
              iconImage: ['coalesce', ['image', ['concat', ['get', 'maki'], '-15']], ['image', 'marker-15']],
              iconSize: 1,
              iconAllowOverlap: false,
              iconOpacity: 0.85,
              iconAnchor: 'bottom',
            }}
          />
        )}
```

`minZoomLevel={14}` keeps places from appearing while the map is showing a whole city, where they would be noise.

- [ ] **Step 6: Accept the switch as a prop**

In `RideMapViewProps`:

```ts
  /** Draw the places layer. Off while the rider is choosing nothing. */
  showPlaces?: boolean;
```

Destructure `showPlaces = false` with the others — off unless a screen asks for it.

- [ ] **Step 7: Turn it on where choosing a destination happens**

In `apps/client/app/(tabs)/index.tsx`, on the `SelectingView` fullscreen `<RideMapView>` only:

```tsx
        showPlaces
```

Not on the fare-review, searching, active-ride or trip-detail maps: there the destination is already decided and places would only compete with the route.

- [ ] **Step 8: Verify**

Run: `pnpm check-types` → 10/10
Run: `pnpm --filter client lint` → 0 errors, ≤66 warnings

- [ ] **Step 9: Commit**

```bash
git add packages/utils apps/client
git commit -m "feat(client): draw places from the tiles the app already downloads"
```

---

## Task 3: Tap a place to go there

**Files:**
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `apps/client/app/(tabs)/index.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json`

- [ ] **Step 1: Accept the callback**

In `RideMapViewProps`:

```ts
  /** A place on the map was chosen. Receives its name and [lng, lat]. */
  onPlacePress?: (name: string, lng: number, lat: number) => void;
```

Destructure it.

- [ ] **Step 2: Query the layer where the finger landed**

`MapView.onPress` carries the screen point; `queryRenderedFeaturesAtPoint` takes pixels and can be limited to one layer. Add to `<MapboxGL.MapView>`:

```tsx
        onPress={showPlaces && onPlacePress ? async (feature: any) => {
          const x = feature?.properties?.screenPointX;
          const y = feature?.properties?.screenPointY;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          try {
            const hits = await mapRef.current?.queryRenderedFeaturesAtPoint(
              [x, y],
              undefined,
              [POI_LAYER_ID],
            );
            const hit = hits?.features?.[0];
            const name = poiNameFromFeature(hit);
            const coords = (hit?.geometry as { coordinates?: number[] } | undefined)?.coordinates;
            // An unnamed place is not a destination anyone can confirm.
            if (!name || !Array.isArray(coords)) return;
            const [lng, lat] = coords;
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            void triggerSelection();
            onPlacePress(name, lng as number, lat as number);
          } catch {
            // A failed query just means no place was chosen.
          }
        } : undefined}
```

This needs a ref on the MapView. If `mapRef` doesn't already exist in this component, add `const mapRef = useRef<any>(null);` next to `cameraRef` and put `ref={mapRef}` on `<MapboxGL.MapView>`.

- [ ] **Step 3: Route the choice into the pin confirmation**

In `index.tsx`, `SelectingView` already receives `openPickerAt` from wave 1. Pass the place through the same door so its address is still resolved and confirmed:

```tsx
        onPlacePress={(_name, lng, lat) => openPickerAt(lng, lat)}
```

The name is deliberately ignored: the pin confirmation reverse-geocodes the coordinate and shows the rider what it found. Trusting a tile label as the ride's address is how a destination ends up saying one thing and pointing somewhere else.

- [ ] **Step 4: Verify**

Run: `pnpm check-types` → 10/10
Run: `pnpm --filter client test` → 35 passed
Run: `pnpm --filter client lint` → 0 errors, ≤66 warnings

- [ ] **Step 5: Commit**

```bash
git add apps/client
git commit -m "feat(client): tap a place on the map to go there"
```

---

## Task 4: 3D buildings behind a switch

**Files:**
- Create: `apps/client/src/hooks/useMapDetail.ts`
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `apps/client/app/(tabs)/index.tsx`, `apps/client/src/components/RideActiveView.tsx`
- Modify: `apps/client/app/profile/settings.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json`

- [ ] **Step 1: The preference hook**

Create `apps/client/src/hooks/useMapDetail.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const MAP_DETAIL_KEY = '@tricigo/map_detail';

/**
 * Whether to draw the heavier map layers (3D buildings).
 *
 * Off by default and opt-in, deliberately: there is no device-capability
 * detection in this codebase, so the alternative would be handing every
 * rider on modest hardware a slower map they never asked for. Mirrors the
 * driver app's `driver_simple_map_mode`, which likewise only suppresses
 * visual layers.
 */
export function useMapDetail(): { mapDetail: boolean; setMapDetail: (v: boolean) => void } {
  const [mapDetail, setState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(MAP_DETAIL_KEY)
      .then((v) => { if (!cancelled) setState(v === '1'); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const setMapDetail = useCallback((v: boolean) => {
    setState(v);
    AsyncStorage.setItem(MAP_DETAIL_KEY, v ? '1' : '0').catch(() => {});
  }, []);

  return { mapDetail, setMapDetail };
}
```

- [ ] **Step 2: The buildings layer**

In `RideMapViewProps`:

```ts
  /** Draw 3D buildings. Opt-in — see useMapDetail. */
  show3dBuildings?: boolean;
```

Destructure `show3dBuildings = false`. Add the layer right after the places layer (both come from the same source, and buildings must sit under every marker):

```tsx
        {show3dBuildings && (
          <MapboxGL.FillExtrusionLayer
            id="tricigo-buildings"
            sourceID={POI_SOURCE_ID}
            sourceLayerID="building"
            minZoomLevel={15}
            filter={['==', ['get', 'extrude'], 'true'] as never}
            style={{
              fillExtrusionColor: isDark ? '#2a2a3e' : '#dcdcdc',
              fillExtrusionHeight: ['get', 'height'],
              fillExtrusionBase: ['get', 'min_height'],
              // Not data-driven for this property — a single value only.
              fillExtrusionOpacity: 0.6,
            }}
          />
        )}
```

- [ ] **Step 3: Feed it from the two screens with a map worth detailing**

In `index.tsx` `SelectingView` and in `RideActiveView`, call `useMapDetail()` and pass `show3dBuildings={mapDetail}` to their `<RideMapView>`.

- [ ] **Step 4: The settings row**

In `apps/client/app/profile/settings.tsx`, add a `ProfileRow` alongside the existing preference rows, using the same `Switch`-in-`right` shape as `notificationsEnabled`:

```tsx
        <ProfileRow
          icon="business"
          label={t('settings.map_detail')}
          subtitle={t('settings.map_detail_hint')}
          right={<Switch value={mapDetail} onValueChange={setMapDetail} />}
        />
```

Wire it with `const { mapDetail, setMapDetail } = useMapDetail();`. `ProfileRow` takes exactly `icon` (an Ionicons name), `label`, `subtitle` and `right` (`ProfileRow.tsx:8-15`), so the shape above is correct as written — place it inside the same `ProfileSection` as the other preference rows.

- [ ] **Step 5: The copy, in all three locales**

**Corrected during implementation.** The settings screen's `useTranslation` is bound to `common`, not `rider` (`settings.tsx:43`), and there is no `"settings"` object in any locale — the screen's preference rows use `profile.*` keys (`profile.notif_sms` / `profile.notif_sms_desc`). Keys placed in `rider.json` would have resolved to nothing.

In each `packages/i18n/src/locales/{es,en,pt}/common.json`, inside the existing `"profile"` object, next to `notif_sms_desc`:

- es: `"map_detail": "Mapa detallado"` / `"map_detail_desc": "Muestra edificios en 3D. Puede ir más lento en teléfonos modestos."`
- en: `"map_detail": "Detailed map"` / `"map_detail_desc": "Shows 3D buildings. May run slower on modest phones."`
- pt: `"map_detail": "Mapa detalhado"` / `"map_detail_desc": "Mostra prédios em 3D. Pode ficar mais lento em telefones modestos."`

The row therefore uses `t('profile.map_detail')` / `t('profile.map_detail_desc')`, matching the `_desc` suffix its neighbours use.

Edit the JSON **as text**. Never `JSON.parse` + `JSON.stringify` — it destroys accent escaping.

- [ ] **Step 6: Verify**

Run: `pnpm check-types` → 10/10
Run: `pnpm check:i18n` → parity clean
Run: `pnpm --filter client lint` → 0 errors, ≤66 warnings

- [ ] **Step 7: Commit**

```bash
git add apps/client packages/i18n/src/locales
git commit -m "feat(client): optional 3D buildings behind a settings switch"
```

---

## Task 5: Full verification

- [ ] `pnpm check-types` → `Tasks: 10 successful, 10 total`
- [ ] `pnpm --filter @tricigo/utils test` → 643 + 12 new = 655
- [ ] `pnpm --filter client test` → 35 passed
- [ ] `pnpm --filter client lint` → 0 errors, warnings ≤ 66
- [ ] `pnpm check:i18n` → no missing translations

---

## Risks to settle on the device

**The `composite` source name.** Every Mapbox Streets style uses it, but if `light-v11` names its source differently, both new layers render nothing — silently, with no error. This is the first thing to check: if no places appear at zoom 14+, that's the cause, and the fix is reading the real source id off the loaded style.

**Maki icon names.** `iconImage` builds a sprite name from the feature's `maki` property. The `coalesce` fallback to `marker-15` should cover unknown values, but if the style's sprite uses unsuffixed names (`restaurant` rather than `restaurant-15`), every icon falls back to the generic pin — visible immediately, cosmetic only.

**Tap precedence.** The vehicle `ShapeSource` already has its own `onPress`. If the source-level handler consumes taps before `MapView.onPress`, tapping a place that sits under a vehicle would select the vehicle. Acceptable, but worth knowing which wins.

## On-device checklist (the user runs this)

1. **Places appear** at zoom 14 and closer in vehicle selection, as small icons, and do not appear on the active-ride map.
2. **Tapping a place** opens the pin confirmation at that spot with the address resolved — and the address comes from the geocoder, not from the tile's label.
3. **Places stay out of the way** of the pickup and dropoff pins.
4. **The switch in Ajustes** turns 3D buildings on; with it off the map looks exactly as it did before this wave.
5. **Offline still works**: turn on airplane mode in an area used before and confirm the map still draws. Then confirm the pack was refreshed once (a `[OfflineMap] style changed` line in dev) and not on every run.
6. **The driver app is untouched.**

---

## Post-device addendum (2026-08-21, live session)

**The sub-venue ranking fix was measured and deliberately NOT shipped.** Evidence, so nobody re-derives it:

- Reproduced in prod: pin at the Manzana building's centre → `lookup_nearest_poi_ranked` returns "Rooftop Pool & Bar" (non-admin, category hotel, 11.6 m) over "Gran Hotel Manzana Kempinski" (is_admin, confidence 1, ~23 m). The hotel is a whole city block represented by one point; its amenities carry their own closer points.
- Any distance-allowance for admin landmarks regresses 00550's measured control: Parque Céspedes (7 m, non-admin) must keep beating Iberostar Grand Trinidad (25 m, **is_admin conf 1**). The gap that would fix Manzana (≥23 m) and the gap that must not flip Trinidad (≤25 m) leave no usable threshold.
- The surgical-looking rule — suppress non-admin hotel-category POIs within 60 m of an admin hotel — was measured platform-wide before shipping: **721 suppressed, and the sample is legitimate neighbouring casas particulares** (Hostal El Porvenir / Hostal Casa Yeya, distinct businesses 60 m apart). Cuba's admin hotel category includes hostales, and hostales cluster. The rule is a 721-victim regression wearing a fix's clothes.

**Conclusion:** the clean fix needs data the model doesn't have — venue footprints or curated parent-child links for large landmarks. Until then, the client-side fixes (11 m cache cells + the distance-gated fallback) cover the reported symptom; the residual case only fires when the pin genuinely sits within 20 m of an amenity's own point, which is at least honest.
