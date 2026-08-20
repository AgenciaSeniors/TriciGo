# Map wave 1 — "the map recognizes you" implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the passenger map acknowledge the person using it — draw them on it, answer their touch, and confirm their actions physically.

**Architecture:** Five self-contained changes to two existing map components plus one call site. No new screens, no backend. The riskiest piece (long-press to set a destination) deliberately funnels into the existing pin-confirmation flow instead of inventing a parallel path, so a stray gesture can never produce a ride with an invented address.

**Tech stack:** `@rnmapbox/maps` ~10.3, Expo SDK 55, RN 0.83, TypeScript strict. APIs below were read from `node_modules`, not assumed.

**Spec:** [docs/superpowers/specs/2026-08-20-client-map-liveliness-design.md](../specs/2026-08-20-client-map-liveliness-design.md)

---

## Verified API facts (do not re-derive)

- `MapboxGL.UserLocation`'s `renderMode` is **deprecated** in favour of `MapboxGL.LocationPuck` (`node_modules/@rnmapbox/maps/lib/typescript/src/components/UserLocation.d.ts:39`). Use `LocationPuck`.
- `LocationPuck` props: `visible`, `puckBearing?: 'heading' | 'course'`, `puckBearingEnabled?: boolean`, `pulsing?: {...} | 'default'`, `scale`. It draws the native puck — **no image asset needed**.
- `MapView.onLongPress?: (feature: GeoJSON.Feature<GeoJSON.Point, ScreenPointPayload>) => void`. The tapped coordinate is `feature.geometry.coordinates` in **[lng, lat]** order.
- `ShapeSource.onPress?: (event: OnPressEvent) => void` where `OnPressEvent = { features: GeoJSON.Feature[]; coordinates: { latitude, longitude }; point: { x, y } }`. GL layers are not views — a tap must be taken on the `ShapeSource`, not the `SymbolLayer`.
- `triggerHaptic(type?: 'light'|'medium'|'heavy'|'success'|'warning'|'error')` and `triggerSelection()` from `@tricigo/utils` (`packages/utils/src/haptics.ts`). Both are async and no-op on web.
- `NearbyVehicle` (`packages/types/src/driver.ts:226`) already carries `eta_seconds` and `distance_to_pickup_m`; the map's local `NearbyVehicleMarker` interface drops them.

---

## Task 1: ETA label helper (pure, testable)

The nearby-vehicle callout needs a short label from `eta_seconds`. Extracting it keeps the formatting decisions out of the component and under test.

**Files:**
- Create: `packages/utils/src/mapCallout.ts`
- Modify: `packages/utils/src/index.ts`
- Test: `packages/utils/src/__tests__/mapCallout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatVehicleEta } from '../mapCallout';

describe('formatVehicleEta', () => {
  it('rounds up to whole minutes so nobody is promised less than the wait', () => {
    expect(formatVehicleEta(61)).toBe('2 min');
    expect(formatVehicleEta(120)).toBe('2 min');
  });

  it('never says "0 min" — under a minute is still a minute away', () => {
    expect(formatVehicleEta(5)).toBe('1 min');
    expect(formatVehicleEta(0)).toBe(null);
  });

  it('returns null when there is no estimate rather than inventing one', () => {
    expect(formatVehicleEta(null)).toBe(null);
    expect(formatVehicleEta(undefined)).toBe(null);
    expect(formatVehicleEta(NaN)).toBe(null);
  });

  it('caps absurd values instead of rendering a wall of digits', () => {
    expect(formatVehicleEta(60 * 60 * 3)).toBe('60+ min');
  });

  it('rejects negatives from clock skew', () => {
    expect(formatVehicleEta(-30)).toBe(null);
  });
});

describe('formatVehicleDistance', () => {
  it('uses metres below a kilometre, rounded to something readable', () => {
    expect(formatVehicleDistance(120)).toBe('120 m');
    expect(formatVehicleDistance(127)).toBe('130 m');
  });

  it('switches to kilometres with one decimal past 1000 m', () => {
    expect(formatVehicleDistance(1000)).toBe('1.0 km');
    expect(formatVehicleDistance(2450)).toBe('2.5 km');
  });

  it('returns null rather than inventing a distance', () => {
    expect(formatVehicleDistance(null)).toBe(null);
    expect(formatVehicleDistance(undefined)).toBe(null);
    expect(formatVehicleDistance(NaN)).toBe(null);
    expect(formatVehicleDistance(-5)).toBe(null);
  });
});
```

Import both at the top of the test file: `import { formatVehicleEta, formatVehicleDistance } from '../mapCallout';`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tricigo/utils test -- mapCallout`
Expected: FAIL — `Failed to resolve import "../mapCallout"`

- [ ] **Step 3: Write minimal implementation**

Create `packages/utils/src/mapCallout.ts`:

```ts
/** Longest wait worth spelling out; past this the exact number stops helping. */
const MAX_ETA_MIN = 60;

/**
 * Short ETA label for a vehicle callout on the map.
 *
 * Rounds UP: showing "1 min" for a 90-second wait reads as a broken promise,
 * while "2 min" that arrives early reads as a good surprise. Returns null
 * when there is no usable estimate — the caller then shows the vehicle type
 * alone rather than a fabricated number.
 */
export function formatVehicleEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.ceil(seconds / 60);
  if (minutes > MAX_ETA_MIN) return `${MAX_ETA_MIN}+ min`;
  return `${minutes} min`;
}

/**
 * Fallback for a vehicle with no ETA (the RPC only computes one when a
 * pickup is set). Metres up to a kilometre, then one decimal — "2.5 km"
 * carries as much as anyone needs from a marker on a map.
 */
export function formatVehicleDistance(metres: number | null | undefined): string | null {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return null;
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
```

Add to `packages/utils/src/index.ts`, next to the other map exports (after the `mapStyles` export line):

```ts
export { formatVehicleEta, formatVehicleDistance } from './mapCallout';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tricigo/utils test -- mapCallout`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/mapCallout.ts packages/utils/src/__tests__/mapCallout.test.ts packages/utils/src/index.ts
git commit -m "feat(utils): ETA label helper for map callouts"
```

---

## Task 2: Draw the rider on their own map

**Files:**
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `apps/client/src/components/ConfirmLocationScreen.tsx`

- [ ] **Step 1: Add the puck to RideMapView**

In `RideMapView.tsx`, inside `<MapboxGL.MapView>`, immediately after the `<MapboxGL.Camera ... />` element and before `<MapboxGL.Images ... />`:

```tsx
        {/* The rider on their own map. Until now the app drew the rider's
            position on the DRIVER's map (via useRiderLocationSharing) but
            never here, so the passenger watched a map they weren't in.
            Renders nothing when location permission is denied. */}
        <MapboxGL.LocationPuck
          visible
          puckBearing="heading"
          puckBearingEnabled
          pulsing={{ isEnabled: true, color: MAP_COLORS.driver, radius: 'accuracy' }}
        />
```

- [ ] **Step 2: Add the puck to the pin picker**

In `ConfirmLocationScreen.tsx`, inside `<MapboxGL.MapView>`, right after the `<MapboxGL.Camera ... />` element:

```tsx
        {/* Orientation while dragging the map under the fixed pin: without
            this the rider has no anchor for where they actually are. */}
        <MapboxGL.LocationPuck visible puckBearing="heading" puckBearingEnabled />
```

- [ ] **Step 3: Verify types**

Run: `pnpm check-types`
Expected: `Tasks: 10 successful, 10 total`

- [ ] **Step 4: Commit**

```bash
git add apps/client/src/components/RideMapView.tsx apps/client/src/components/ConfirmLocationScreen.tsx
git commit -m "feat(client): draw the rider's own location on the map"
```

---

## Task 3: Haptics on the silent moments

Three map actions currently give no physical feedback. `triggerHaptic` / `triggerSelection` already exist and are used elsewhere in the app — never near the map.

**Files:**
- Modify: `apps/client/src/components/ConfirmLocationScreen.tsx`
- Modify: `apps/client/src/hooks/useRide.ts`

- [ ] **Step 1: Buzz when the pin settles somewhere new**

In `ConfirmLocationScreen.tsx`, add `triggerSelection` to the existing `@tricigo/utils` import.

In `handleMapIdle`, the previous centre must be captured **before** `centerRef.current` is overwritten — the existing code reassigns it on the line above the geocode call, so comparing after the fact always yields zero. Replace the inner block:

```tsx
        if (center && Array.isArray(center) && center.length === 2) {
          const [lng, lat] = center;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Capture before overwriting: comparing against centerRef after
            // the assignment would always measure zero movement.
            const previous = centerRef.current;
            centerRef.current = { latitude: lat, longitude: lng };
            // Only when the pin actually landed somewhere else. A map that
            // settles a metre after the finger lifts should stay silent.
            if (haversineDistance(previous, { latitude: lat, longitude: lng }) > 15) {
              void triggerSelection();
            }
            geocodeCenter(lat, lng);
            return;
          }
        }
```

- [ ] **Step 2: Buzz on confirm**

In `handleConfirm`, immediately after `setConfirming(true)`:

```tsx
    void triggerHaptic('light');
```

Add `triggerHaptic` to the same `@tricigo/utils` import.

- [ ] **Step 3: Buzz when a driver accepts**

Not in `useRide.ts` — the client learns about acceptance through the Presence broadcast in `apps/client/src/hooks/useSearchingDrivers.ts`, which is the single place it arrives. Add `triggerHaptic` to that file's imports (from `@tricigo/utils`) and fire it where the accepted-driver broadcast is handled, right before the accept animation is started:

```ts
      // The moment worth feeling: someone took your ride.
      void triggerHaptic('success');
```

- [ ] **Step 4: Verify types**

Run: `pnpm check-types`
Expected: `Tasks: 10 successful, 10 total`

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/ConfirmLocationScreen.tsx apps/client/src/hooks/useRide.ts
git commit -m "feat(client): haptic feedback for pin, confirm and driver accept"
```

---

## Task 4: Tappable vehicles

Two payoffs from one mechanism: tapping the assigned driver re-centres on them, tapping a nearby vehicle shows what it is and how far away it is — data the RPC already returns and the map currently throws away.

**Files:**
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json`

- [ ] **Step 1: Carry the discarded fields into the marker type**

In `RideMapView.tsx`, extend the local interface (it currently drops both fields):

```ts
interface NearbyVehicleMarker {
  driver_profile_id: string;
  latitude: number;
  longitude: number;
  vehicle_type: string;
  heading?: number | null;
  eta_seconds?: number | null;
  distance_to_pickup_m?: number | null;
}
```

- [ ] **Step 2: Put them in the GeoJSON properties**

In the `nearbyGeoJSON` `useMemo`, extend `properties`:

```ts
        properties: {
          id: v.driver_profile_id,
          icon: `marker-${v.vehicle_type || 'auto'}`,
          // The SymbolLayer below reads ['get','heading'] for iconRotate.
          // Without this property every nearby vehicle rendered facing north.
          heading: v.heading ?? 0,
          etaSeconds: v.eta_seconds ?? null,
          distanceM: v.distance_to_pickup_m ?? null,
        },
```

The callout deliberately does **not** name the vehicle type. `vehicle_type` on a nearby vehicle (`triciclo`, `moto`, `auto`) is not a service slug, so the existing `service_type.*` translations don't match it, and the marker icon already says what kind of vehicle it is. Repeating it in text would add five new keys across three locales to tell the rider something they can already see.

- [ ] **Step 3: Hold the selected vehicle**

Near the other `useState` declarations in `RideMapViewInner`:

```ts
  const [tappedVehicle, setTappedVehicle] = useState<{
    coordinate: [number, number];
    label: string;
  } | null>(null);
```

- [ ] **Step 4: Take the tap on the nearby-vehicle source**

Add `onPress` to the nearby vehicles `<MapboxGL.ShapeSource>`:

```tsx
          onPress={(e: { features: Array<{ geometry?: any; properties?: any }> }) => {
            const f = e.features?.[0];
            const coords = f?.geometry?.coordinates;
            if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return;
            const eta = formatVehicleEta(f?.properties?.etaSeconds);
            const dist = formatVehicleDistance(f?.properties?.distanceM);
            // No ETA and no distance means there is nothing to tell the
            // rider — stay silent rather than open an empty bubble.
            const label = eta
              ? t('map.vehicle_eta', { eta })
              : dist
                ? t('map.vehicle_distance', { distance: dist })
                : null;
            if (!label) return;
            void triggerSelection();
            setTappedVehicle({ coordinate: [coords[0], coords[1]], label });
          }}
```

- [ ] **Step 5: Re-centre when the driver is tapped**

Add `onPress` to the driver's `<MapboxGL.ShapeSource>`:

```tsx
          onPress={() => {
            if (!animatedDriver) return;
            void triggerSelection();
            cameraRef.current?.setCamera({
              centerCoordinate: [animatedDriver.longitude, animatedDriver.latitude],
              zoomLevel: 16,
              animationDuration: 600,
              animationMode: 'flyTo',
            });
          }}
```

- [ ] **Step 6: Render the callout**

After the nearby-vehicles `ShapeSource` block, still inside `MapView`:

```tsx
        {tappedVehicle && (
          <MapboxGL.MarkerView
            id="vehicle-callout"
            coordinate={tappedVehicle.coordinate}
            anchor={{ x: 0.5, y: 1.6 }}
          >
            <Pressable
              onPress={() => setTappedVehicle(null)}
              accessibilityRole="button"
              accessibilityLabel={t('map.dismiss_callout', { defaultValue: 'Cerrar' })}
              style={{
                backgroundColor: isDark ? darkColors.card : '#ffffff',
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: isDark ? darkColors.text.primary : colors.neutral[800] }}>
                {tappedVehicle.label}
              </Text>
            </Pressable>
          </MapboxGL.MarkerView>
        )}
```

Add `Pressable` to the `react-native` import, and `formatVehicleEta`, `formatVehicleDistance`, `triggerSelection` to the `@tricigo/utils` import.

- [ ] **Step 7: Dismiss the callout when the vehicles change**

The callout is anchored to a fixed coordinate; once the underlying vehicle moves or leaves, it would point at nothing. Add next to the other effects:

```ts
  // A callout pinned to a stale coordinate is worse than no callout.
  useEffect(() => {
    setTappedVehicle(null);
  }, [nearbyVehicles]);
```

- [ ] **Step 8: Add the copy to all three locales**

In each of `packages/i18n/src/locales/{es,en,pt}/rider.json`, inside the existing `"map"` object:

- es: `"vehicle_eta": "a {{eta}} de ti"` and `"vehicle_distance": "a {{distance}}"`
- en: `"vehicle_eta": "{{eta}} away"` and `"vehicle_distance": "{{distance}} away"`
- pt: `"vehicle_eta": "a {{eta}} de você"` and `"vehicle_distance": "a {{distance}}"`

`map.dismiss_callout` stays a `defaultValue` — it's an accessibility label, not visible copy, per the project convention.

- [ ] **Step 9: Verify**

Run: `pnpm check-types`
Expected: `Tasks: 10 successful, 10 total`

Run: `pnpm check:i18n`
Expected: `✓ i18n parity: … no missing translations`

- [ ] **Step 10: Commit**

```bash
git add apps/client/src/components/RideMapView.tsx packages/i18n/src/locales
git commit -m "feat(client): tap a vehicle on the map to see it or follow it"
```

---

## Task 5: Long-press to set a destination

Funnels into the existing pin-confirmation flow (00537) so the address is still reverse-geocoded and confirmed. A stray long-press can therefore never create a ride with a made-up address.

**Files:**
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `apps/client/app/(tabs)/index.tsx`

- [ ] **Step 1: Expose the gesture from the map component**

Add to `RideMapViewProps`:

```ts
  /** Long-press anywhere on the map. Receives [lng, lat]. */
  onLongPressMap?: (lng: number, lat: number) => void;
```

Destructure `onLongPressMap` with the other props, then add to `<MapboxGL.MapView>`:

```tsx
        onLongPress={onLongPressMap ? (feature: any) => {
          const coords = feature?.geometry?.coordinates;
          if (!Array.isArray(coords)) return;
          const [lng, lat] = coords;
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
          void triggerHaptic('medium');
          onLongPressMap(lng, lat);
        } : undefined}
```

Add `triggerHaptic` to the `@tricigo/utils` import.

- [ ] **Step 2: Let the picker open at an arbitrary point**

In `index.tsx`, next to the `mapPickerMode` state (line ~1756):

```tsx
  // A long-press on the map seeds the picker with that exact point instead
  // of the existing dropoff. Cleared whenever the picker closes.
  const [pickerSeed, setPickerSeed] = useState<{ latitude: number; longitude: number } | null>(null);
```

- [ ] **Step 3: Use the seed as the picker's starting point**

In the `pickerInitialLoc` chain, make the seed win:

```tsx
      const pickerInitialLoc =
        pickerSeed ??
        (mapPickerMode === 'pickup'
          ? draft.pickup?.location ?? null
          : mapPickerMode === 'waypoint'
            ? lastWaypoint?.location ?? draft.pickup?.location ?? null
            : draft.dropoff?.location ?? draft.pickup?.location ?? null);
```

Clear the seed in both exits of `ConfirmLocationScreen` — in `onConfirm` next to each `setMapPickerMode(null)`, and in `onClose`:

```tsx
            onClose={() => { setPickerSeed(null); setMapPickerMode(null); }}
```

- [ ] **Step 4: Pass the opener down to SelectingView**

Change the `SelectingView` signature and its call site to carry a second prop:

```tsx
function SelectingView({ setMapPickerMode, openPickerAt }: {
  setMapPickerMode: (mode: 'pickup' | 'dropoff' | 'dropoff-confirm' | 'waypoint' | null) => void;
  openPickerAt: (lng: number, lat: number) => void;
}) {
```

At the call site (line ~1836):

```tsx
    return (
      <SelectingView
        setMapPickerMode={setMapPickerMode}
        openPickerAt={(lng, lat) => {
          setPickerSeed({ latitude: lat, longitude: lng });
          setMapPickerMode('dropoff-confirm');
        }}
      />
    );
```

- [ ] **Step 5: Wire the gesture on the fullscreen map**

On the `<RideMapView>` in `SelectingView`, add:

```tsx
        onLongPressMap={openPickerAt}
```

- [ ] **Step 6: Verify**

Run: `pnpm check-types`
Expected: `Tasks: 10 successful, 10 total`

Run: `pnpm --filter client test`
Expected: `Tests  35 passed (35)`

- [ ] **Step 7: Commit**

```bash
git add apps/client
git commit -m "feat(client): long-press the map to set a destination"
```

---

## Task 6: Full verification pass

- [ ] **Step 1: Types across all four apps**

Run: `pnpm check-types`
Expected: `Tasks: 10 successful, 10 total`

- [ ] **Step 2: Tests**

Run: `pnpm --filter client test` → `Tests  35 passed`
Run: `pnpm --filter @tricigo/utils test` → 634 passed (625 existing + 9 new)

- [ ] **Step 3: Lint — no new warnings**

Run: `pnpm --filter client lint`
Expected: `0 errors`. Warning count must not exceed **66** (the measured baseline on this branch; master is 67).

- [ ] **Step 4: i18n parity**

Run: `pnpm check:i18n`
Expected: `✓ i18n parity: … no missing translations`

---

## On-device checklist (the user runs this, not the assistant)

Metro from this worktree after copying `.env` (`apps/client/.env` is gitignored — without it the map crashes on a missing Mapbox token; Metro must print `env: load .env`).

1. **Puck** — appears at your position, points where you're facing, follows you as you walk. Deny location permission → nothing renders, nothing crashes.
2. **Puck vs pickup pin** — with a pickup set a few metres away, the blue puck and the green pulsing pickup marker must read as clearly different things. This is the risk flagged in the spec.
3. **Haptics** — buzz when the pin settles somewhere new (not on every tiny settle), on confirm, and when a driver accepts.
4. **Tap a nearby vehicle** — callout shows type and "X min"; tapping it dismisses; it disappears when the vehicles refresh instead of pointing at empty road.
5. **Tap the driver** during an active ride — camera flies to them.
6. **Long-press** — opens the confirm screen at that exact point with the address resolved. Then the important negative test: **drag the map slowly** and confirm a long-press does NOT fire when you meant to pan.
7. **Driver app untouched.**
