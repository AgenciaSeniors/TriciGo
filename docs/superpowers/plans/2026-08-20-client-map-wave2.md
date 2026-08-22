# Map wave 2 — "the map moves" implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the map's contents move like things in the world instead of updating like a spreadsheet.

**Architecture:** One pure reducer drives all nearby-vehicle motion (interpolation plus enter/exit fade) from a single animation loop, because hooks can't be called per-vehicle. The driver's ETA rides along as a React view anchored to the marker, and travelled route is painted by trimming a second line layer rather than recomputing geometry.

**Tech stack:** `@rnmapbox/maps` ~10.3, Expo SDK 55, RN 0.83, TypeScript strict, vitest.

**Spec:** [docs/superpowers/specs/2026-08-20-client-map-liveliness-design.md](../specs/2026-08-20-client-map-liveliness-design.md)

---

## Verified facts (read from source — do not re-derive)

- `useAnimatedCoordinate` is a hook and **cannot** be called inside a `.map()` over N vehicles. Wave 2 needs one loop for all of them.
- `nearbyGeoJSON` (`RideMapView.tsx:508-528`) is built straight from the raw prop; features carry only `id`, `icon`, `heading`. Vehicles jump on every refresh: 15 s in production (`useNearbyVehicles.ts:23`), **1 s** in the dev/demo preview (`useTestVehicles.ts:24-27`) — which is the only mode with vehicles to look at before launch.
- **Nobody in the monorepo draws map-layer text.** `textField` has zero occurrences in `apps/` and `packages/`; every `SymbolLayer` is icons-only. Existing on-map text is a `MarkerView` with RN children (the vehicle callout, `RideMapView.tsx:1236`). Wave 2 follows that proven path rather than introducing `textField`, whose glyph/font failure mode is silent.
- `MarkerView` only remounts when given a changing `key` — the dropoff marker does that deliberately. Without a key it tracks a moving coordinate without remounting.
- `lineTrimOffset?: number[]` exists (`MapboxStyles.d.ts:585`). The span between `[start, end]` is painted with `lineTrimColor`, transparent by default, so `[progress, 1]` leaves `0→progress` visible.
- **It does require `lineMetrics: true` on the source**, same as `lineGradient`. The TypeScript types don't say so — only the style validator does (`node_modules/mapbox-gl/dist/mapbox-gl-dev.js` gates on `line-gradient || line-trim-offset` against `!source.lineMetrics`). An earlier draft of this plan claimed the opposite, and without the flag the progress layer paints the whole route instead of the travelled part.
- `useTripProgress` (`apps/client/src/hooks/useTripProgress.ts:40`) already returns `progressPercent` (**0-100**, not 0-1), throttled to 5 s and monotonic, active only in `in_progress` / `arrived_at_destination`. `RideActiveView.tsx:178` already holds it. No new progress math is needed.
- The component already re-renders ~33×/s from the ant-march loop (`RideMapView.tsx:210-235`), so a second animation loop adds frames, not a new class of cost.

---

## Task 1: The vehicle animation reducer (pure, TDD)

All motion state for every nearby vehicle advanced by one function. Pure so the tricky parts — a vehicle arriving, leaving, or being replaced mid-flight — are testable without a renderer.

**Files:**
- Create: `packages/utils/src/animateVehicles.ts`
- Modify: `packages/utils/src/index.ts`
- Test: `packages/utils/src/__tests__/animateVehicles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { stepVehicles, type VehicleTarget, type VehicleAnimState } from '../animateVehicles';

const OPTS = { moveMs: 1000, fadeMs: 400 };
const A: VehicleTarget = { id: 'a', latitude: 23.0, longitude: -82.0, heading: 90, vehicleType: 'triciclo' };

describe('stepVehicles', () => {
  it('shows a newly seen vehicle at its real position, faded in from nothing', () => {
    const { rendered } = stepVehicles(new Map(), [A], 0, OPTS);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.latitude).toBe(23.0);
    expect(rendered[0]!.opacity).toBe(0);
  });

  it('completes the fade-in over fadeMs', () => {
    const first = stepVehicles(new Map(), [A], 0, OPTS);
    const mid = stepVehicles(first.next, [A], 200, OPTS);
    const done = stepVehicles(mid.next, [A], 400, OPTS);
    expect(mid.rendered[0]!.opacity).toBeCloseTo(0.5, 2);
    expect(done.rendered[0]!.opacity).toBe(1);
  });

  it('slides between positions instead of teleporting', () => {
    const seen = stepVehicles(new Map(), [A], 0, OPTS);
    const settled = stepVehicles(seen.next, [A], 400, OPTS);
    const moved = stepVehicles(settled.next, [{ ...A, latitude: 24.0 }], 400, OPTS);
    const half = stepVehicles(moved.next, [{ ...A, latitude: 24.0 }], 900, OPTS);
    expect(half.rendered[0]!.latitude).toBeCloseTo(23.5, 2);
    const arrived = stepVehicles(half.next, [{ ...A, latitude: 24.0 }], 1400, OPTS);
    expect(arrived.rendered[0]!.latitude).toBe(24.0);
  });

  it('starts the next leg from where the vehicle currently IS, not from the old target', () => {
    const seen = stepVehicles(new Map(), [A], 0, OPTS);
    const settled = stepVehicles(seen.next, [A], 400, OPTS);
    const leg1 = stepVehicles(settled.next, [{ ...A, latitude: 24.0 }], 400, OPTS);
    const mid = stepVehicles(leg1.next, [{ ...A, latitude: 24.0 }], 900, OPTS);
    // Redirected mid-flight: must continue from ~23.5, not snap back to 23.0
    const redirected = stepVehicles(mid.next, [{ ...A, latitude: 20.0 }], 900, OPTS);
    expect(redirected.rendered[0]!.latitude).toBeCloseTo(23.5, 2);
  });

  it('fades a departed vehicle out instead of deleting it mid-frame', () => {
    const seen = stepVehicles(new Map(), [A], 0, OPTS);
    const settled = stepVehicles(seen.next, [A], 400, OPTS);
    const leaving = stepVehicles(settled.next, [], 400, OPTS);
    expect(leaving.rendered).toHaveLength(1);
    expect(leaving.rendered[0]!.opacity).toBe(1);
    const half = stepVehicles(leaving.next, [], 600, OPTS);
    expect(half.rendered[0]!.opacity).toBeCloseTo(0.5, 2);
  });

  it('drops a departed vehicle once its fade is done', () => {
    const seen = stepVehicles(new Map(), [A], 0, OPTS);
    const settled = stepVehicles(seen.next, [A], 400, OPTS);
    const leaving = stepVehicles(settled.next, [], 400, OPTS);
    const gone = stepVehicles(leaving.next, [], 801, OPTS);
    expect(gone.rendered).toHaveLength(0);
    expect(gone.next.size).toBe(0);
  });

  it('revives a vehicle that comes back before its fade finished', () => {
    const seen = stepVehicles(new Map(), [A], 0, OPTS);
    const settled = stepVehicles(seen.next, [A], 400, OPTS);
    const leaving = stepVehicles(settled.next, [], 400, OPTS);
    const back = stepVehicles(leaving.next, [A], 600, OPTS);
    const later = stepVehicles(back.next, [A], 1200, OPTS);
    expect(later.rendered).toHaveLength(1);
    expect(later.rendered[0]!.opacity).toBe(1);
  });

  it('takes the shortest way round the compass instead of spinning backwards', () => {
    const near350: VehicleTarget = { ...A, heading: 350 };
    const seen = stepVehicles(new Map(), [near350], 0, OPTS);
    const settled = stepVehicles(seen.next, [near350], 400, OPTS);
    const turning = stepVehicles(settled.next, [{ ...A, heading: 10 }], 400, OPTS);
    const mid = stepVehicles(turning.next, [{ ...A, heading: 10 }], 900, OPTS);
    // 350° → 10° is +20°, so halfway is 0°/360° — never ~180°
    const h = mid.rendered[0]!.heading;
    expect(Math.min(Math.abs(h - 0), Math.abs(h - 360))).toBeLessThan(3);
  });

  it('ignores targets with unusable coordinates', () => {
    const bad: VehicleTarget = { ...A, id: 'bad', latitude: NaN };
    const { rendered } = stepVehicles(new Map(), [bad], 0, OPTS);
    expect(rendered).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tricigo/utils test -- animateVehicles`
Expected: FAIL — `Failed to resolve import "../animateVehicles"`

- [ ] **Step 3: Write the implementation**

Create `packages/utils/src/animateVehicles.ts`:

```ts
import { lerpCoordinate, lerpHeading } from './animateCoordinate';

/** A vehicle as the server reports it. */
export interface VehicleTarget {
  id: string;
  latitude: number;
  longitude: number;
  heading: number;
  vehicleType: string;
}

/** A vehicle as it should be drawn this frame. */
export interface AnimatedVehicle {
  id: string;
  latitude: number;
  longitude: number;
  heading: number;
  /** 0-1. Drives iconOpacity so vehicles fade in and out. */
  opacity: number;
  vehicleType: string;
}

/** Per-vehicle motion state. Opaque to callers — pass it back unchanged. */
export interface VehicleAnimState {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  fromHeading: number;
  toHeading: number;
  moveStartedAt: number;
  /** Timestamp the current fade began; direction comes from `leaving`. */
  fadeStartedAt: number;
  /** Opacity when the current fade began — lets a fade reverse mid-way. */
  fadeFrom: number;
  leaving: boolean;
  vehicleType: string;
}

export interface StepOptions {
  /** Time to slide between two reported positions. */
  moveMs: number;
  /** Time to fade a vehicle in or out. */
  fadeMs: number;
}

function progress(now: number, startedAt: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / durationMs));
}

/**
 * Advance every nearby vehicle by one frame.
 *
 * One function for all of them because `useAnimatedCoordinate` is a hook and
 * can't be called per-vehicle. Pure, so arrivals, departures and mid-flight
 * redirections are testable without a renderer.
 *
 * Returns the next state (feed it back next frame) and what to draw now.
 */
export function stepVehicles(
  prev: Map<string, VehicleAnimState>,
  targets: VehicleTarget[],
  now: number,
  opts: StepOptions,
): { next: Map<string, VehicleAnimState>; rendered: AnimatedVehicle[] } {
  const next = new Map<string, VehicleAnimState>();
  const seen = new Set<string>();

  for (const t of targets) {
    if (!t?.id || !Number.isFinite(t.latitude) || !Number.isFinite(t.longitude)) continue;
    seen.add(t.id);
    const heading = Number.isFinite(t.heading) ? t.heading : 0;
    const existing = prev.get(t.id);

    if (!existing) {
      // First sighting: appear where it actually is, faded out, then fade in.
      next.set(t.id, {
        fromLat: t.latitude, fromLng: t.longitude,
        toLat: t.latitude, toLng: t.longitude,
        fromHeading: heading, toHeading: heading,
        moveStartedAt: now,
        fadeStartedAt: now, fadeFrom: 0,
        leaving: false,
        vehicleType: t.vehicleType,
      });
      continue;
    }

    const moved = existing.toLat !== t.latitude || existing.toLng !== t.longitude;
    const turned = existing.toHeading !== heading;
    // Where it is RIGHT NOW — a new leg must start here, not at the old
    // target, or a vehicle redirected mid-slide would snap backwards.
    const p = progress(now, existing.moveStartedAt, opts.moveMs);
    const current = lerpCoordinate(
      { latitude: existing.fromLat, longitude: existing.fromLng },
      { latitude: existing.toLat, longitude: existing.toLng },
      p,
    );
    const currentHeading = lerpHeading(existing.fromHeading, existing.toHeading, p);
    const wasLeaving = existing.leaving;
    const currentOpacity = wasLeaving
      ? existing.fadeFrom * (1 - progress(now, existing.fadeStartedAt, opts.fadeMs))
      : existing.fadeFrom + (1 - existing.fadeFrom) * progress(now, existing.fadeStartedAt, opts.fadeMs);

    next.set(t.id, {
      fromLat: moved || turned ? current.latitude : existing.fromLat,
      fromLng: moved || turned ? current.longitude : existing.fromLng,
      toLat: t.latitude,
      toLng: t.longitude,
      fromHeading: moved || turned ? currentHeading : existing.fromHeading,
      toHeading: heading,
      moveStartedAt: moved || turned ? now : existing.moveStartedAt,
      // Coming back before the fade-out finished reverses it from wherever
      // it got to, so a flickering vehicle doesn't pop to full opacity.
      fadeStartedAt: wasLeaving ? now : existing.fadeStartedAt,
      fadeFrom: wasLeaving ? currentOpacity : existing.fadeFrom,
      leaving: false,
      vehicleType: t.vehicleType,
    });
  }

  // Anything no longer reported starts (or continues) fading out.
  for (const [id, state] of prev) {
    if (seen.has(id)) continue;
    if (state.leaving) {
      if (progress(now, state.fadeStartedAt, opts.fadeMs) >= 1) continue; // fully gone
      next.set(id, state);
      continue;
    }
    const p = progress(now, state.fadeStartedAt, opts.fadeMs);
    next.set(id, {
      ...state,
      leaving: true,
      fadeStartedAt: now,
      fadeFrom: state.fadeFrom + (1 - state.fadeFrom) * p,
    });
  }

  const rendered: AnimatedVehicle[] = [];
  for (const [id, s] of next) {
    const mp = progress(now, s.moveStartedAt, opts.moveMs);
    const coord = lerpCoordinate(
      { latitude: s.fromLat, longitude: s.fromLng },
      { latitude: s.toLat, longitude: s.toLng },
      mp,
    );
    const fp = progress(now, s.fadeStartedAt, opts.fadeMs);
    const opacity = s.leaving
      ? s.fadeFrom * (1 - fp)
      : s.fadeFrom + (1 - s.fadeFrom) * fp;
    rendered.push({
      id,
      latitude: coord.latitude,
      longitude: coord.longitude,
      heading: lerpHeading(s.fromHeading, s.toHeading, mp),
      opacity: Math.min(1, Math.max(0, opacity)),
      vehicleType: s.vehicleType,
    });
  }
  return { next, rendered };
}
```

Add to `packages/utils/src/index.ts`, right after the `mapCallout` export:

```ts
export { stepVehicles } from './animateVehicles';
export type { VehicleTarget, AnimatedVehicle, VehicleAnimState, StepOptions } from './animateVehicles';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tricigo/utils test -- animateVehicles`
Expected: PASS, 9 tests.

Run: `pnpm --filter @tricigo/utils test`
Expected: all green (634 existing + 9).

Run: `pnpm check-types`
Expected: `Tasks: 10 successful, 10 total`

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/animateVehicles.ts packages/utils/src/__tests__/animateVehicles.test.ts packages/utils/src/index.ts
git commit -m "feat(utils): one reducer to animate every nearby vehicle"
```

---

## Task 2: Wire the reducer into the map

**Files:**
- Create: `apps/client/src/hooks/useAnimatedVehicles.ts`
- Modify: `apps/client/src/components/RideMapView.tsx`

- [ ] **Step 1: The hook that runs the loop**

Create `apps/client/src/hooks/useAnimatedVehicles.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { stepVehicles, type AnimatedVehicle, type VehicleAnimState, type VehicleTarget } from '@tricigo/utils';

/** Matches the 1 Hz cadence the demo preview moves vehicles at; real polls
 *  are slower, and a slide that finishes early just sits still. */
const MOVE_MS = 1000;
const FADE_MS = 400;
/** ~30 FPS. Matches the ant-march loop already running in this component. */
const FRAME_MS = 33;

/**
 * Smooth positions for every nearby vehicle, driven by a single animation
 * loop. `useAnimatedCoordinate` can't do this job — it's a hook, so it
 * can't be called once per vehicle in a list that changes size.
 *
 * Pauses with the app: nobody is watching vehicles glide while backgrounded.
 */
const EMPTY: AnimatedVehicle[] = [];

export function useAnimatedVehicles(targets: VehicleTarget[] | null | undefined): AnimatedVehicle[] {
  const [rendered, setRendered] = useState<AnimatedVehicle[]>(EMPTY);
  const stateRef = useRef<Map<string, VehicleAnimState>>(new Map());
  const targetsRef = useRef<VehicleTarget[]>([]);
  const wasEmptyRef = useRef(true);
  targetsRef.current = targets ?? [];

  useEffect(() => {
    let rafId: number | null = null;
    let lastFrame = 0;

    const frame = (now: number) => {
      if (now - lastFrame >= FRAME_MS) {
        lastFrame = now;
        const { next, rendered: out } = stepVehicles(
          stateRef.current,
          targetsRef.current,
          now,
          { moveMs: MOVE_MS, fadeMs: FADE_MS },
        );
        stateRef.current = next;
        // With nothing to animate, keep handing back the SAME empty array.
        // RideMapView renders on five screens and only two ever pass
        // vehicles; a fresh [] every frame would re-render all of them
        // 30 times a second to draw nothing.
        if (out.length === 0) {
          if (!wasEmptyRef.current) {
            wasEmptyRef.current = true;
            setRendered(EMPTY);
          }
        } else {
          wasEmptyRef.current = false;
          setRendered(out);
        }
      }
      rafId = requestAnimationFrame(frame);
    };

    const start = () => { if (rafId === null) rafId = requestAnimationFrame(frame); };
    const stop = () => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => { sub.remove(); stop(); };
  }, []);

  return rendered;
}
```

- [ ] **Step 2: Feed the hook and draw from it**

In `RideMapView.tsx`, add the import:

```ts
import { useAnimatedVehicles } from '@/hooks/useAnimatedVehicles';
```

Immediately before the `nearbyGeoJSON` useMemo, convert the incoming prop into targets and animate them:

```ts
  // The prop arrives in bursts (15 s in production, 1 s in the demo
  // preview); this turns those jumps into motion.
  const vehicleTargets = useMemo(
    () => (nearbyVehicles ?? []).map((v) => ({
      id: v.driver_profile_id,
      latitude: v.latitude,
      longitude: v.longitude,
      heading: v.heading ?? 0,
      vehicleType: v.vehicle_type || 'auto',
    })),
    [nearbyVehicles],
  );
  const animatedVehicles = useAnimatedVehicles(vehicleTargets);
```

Replace the whole `nearbyGeoJSON` useMemo body so it reads from the animated list and carries opacity:

```ts
  const nearbyGeoJSON = useMemo(() => {
    if (animatedVehicles.length === 0) return null;
    return {
      type: 'FeatureCollection' as const,
      features: animatedVehicles.map((v) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [v.longitude, v.latitude],
        },
        properties: {
          id: v.id,
          icon: `marker-${v.vehicleType}`,
          // The SymbolLayer below reads ['get','heading'] for iconRotate.
          // Without this property every nearby vehicle rendered facing north.
          heading: v.heading,
          opacity: v.opacity,
        },
      })),
    };
  }, [animatedVehicles]);
```

- [ ] **Step 3: Let the icons honour their opacity**

In the `nearby-icons` `SymbolLayer` style, add:

```ts
          iconOpacity: ['get', 'opacity'],
```

- [ ] **Step 4: Keep the callout reading live data**

The callout resolves against `nearbyVehicles` (the raw prop) — leave it that way. It needs the true reported position for its distance, not the interpolated one, and the raw list is what tells us a driver really left.

- [ ] **Step 5: Verify**

Run: `pnpm check-types` → `Tasks: 10 successful, 10 total`
Run: `pnpm --filter client test` → `Tests  35 passed (35)`
Run: `pnpm --filter client lint` → 0 errors, no more than 66 warnings

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/hooks/useAnimatedVehicles.ts apps/client/src/components/RideMapView.tsx
git commit -m "feat(client): nearby vehicles glide and fade instead of teleporting"
```

---

## Task 3: The driver's ETA, on the driver

**Files:**
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `apps/client/src/components/RideActiveView.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/rider.json`

- [ ] **Step 1: Accept the ETA as a prop**

In `RideMapViewProps`:

```ts
  /** Minutes until the driver arrives, drawn in a bubble on the marker.
   *  Omit (or pass null) to draw no bubble. */
  driverEtaMinutes?: number | null;
```

Destructure `driverEtaMinutes` with the other props.

- [ ] **Step 2: Draw the bubble on the marker**

A `MarkerView` with RN children, not a `SymbolLayer` with `textField`: nothing in this repo draws map-layer text, and a missing glyph set fails silently. No `key` prop — that's what keeps it tracking the moving coordinate instead of remounting.

Insert right after the driver's `ShapeSource` block closes, still inside `MapView`:

```tsx
        {animatedDriver && renderedDriverCoord && driverEtaMinutes != null && driverEtaMinutes > 0 && (
          <MapboxGL.MarkerView
            id="driver-eta-bubble"
            coordinate={[renderedDriverCoord.longitude, renderedDriverCoord.latitude]}
            anchor={{ x: 0.5, y: 2.2 }}
            allowOverlap
          >
            <View
              accessibilityLabel={t('map.driver_eta', { eta: formatVehicleEtaMinutes(driverEtaMinutes) })}
              style={{
                backgroundColor: isDark ? darkColors.card : '#ffffff',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 8,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 5,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: isDark ? darkColors.text.primary : colors.neutral[800] }}>
                {formatVehicleEtaMinutes(driverEtaMinutes)}
              </Text>
            </View>
          </MapboxGL.MarkerView>
        )}
```

- [ ] **Step 3: Pass the ETA from the active ride**

`RideActiveView.tsx:242` already holds `displayEtaMinutes` (`routeETA?.durationMinutes ?? etaMinutes`) — the same value the arrival card and the proximity pulse use. On its `<RideMapView ... />` (around line 1110) add:

```tsx
        driverEtaMinutes={displayEtaMinutes}
```

Do not compute a second ETA.

- [ ] **Step 4: Add the accessibility label copy**

In each of `packages/i18n/src/locales/{es,en,pt}/rider.json`, inside the existing `"map"` object:

- es: `"driver_eta": "Tu conductor llega en {{eta}}"`
- en: `"driver_eta": "Your driver arrives in {{eta}}"`
- pt: `"driver_eta": "Seu motorista chega em {{eta}}"`

Edit the JSON **as text**. Never `JSON.parse` + `JSON.stringify` these files — it destroys the accent escaping.

- [ ] **Step 5: Verify**

Run: `pnpm check-types` → 10/10
Run: `pnpm check:i18n` → parity clean
Run: `pnpm --filter client lint` → 0 errors, ≤66 warnings

- [ ] **Step 6: Commit**

```bash
git add apps/client packages/i18n/src/locales
git commit -m "feat(client): show the driver's ETA on the driver, not just in a card"
```

---

## Task 4: Paint the route as it's travelled

**Files:**
- Modify: `apps/client/src/components/RideMapView.tsx`
- Modify: `apps/client/src/components/RideActiveView.tsx`

- [ ] **Step 1: Accept progress as a prop**

In `RideMapViewProps`:

```ts
  /** How much of the route is behind you, 0-1. Paints that much of the line
   *  in the progress colour. Omit while there's no trip underway. */
  routeProgress?: number | null;
```

Destructure it with the others.

- [ ] **Step 2: Add the travelled layer**

Inside the existing route `ShapeSource` (id `route`), after `routeLine`, add a third layer. `lineTrimOffset` hides the span between its two values, so trimming `[progress, 1]` leaves exactly the travelled part visible:

```tsx
            {routeProgress != null && routeProgress > 0 && (
              <MapboxGL.LineLayer
                id="routeProgress"
                style={{
                  lineColor: ROUTE.progress.color,
                  lineWidth: ROUTE.progress.width,
                  lineOpacity: ROUTE.progress.opacity,
                  // Hide everything ahead of the driver; what stays painted
                  // is the part already travelled.
                  lineTrimOffset: [Math.min(1, Math.max(0, routeProgress)), 1],
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
            )}
```

`ROUTE.progress` is already defined in `mapStyles.ts:44` (green, width 5) and has had no consumer until now.

- [ ] **Step 3: Feed it from the active ride**

`RideActiveView.tsx:178` already holds the hook's result as `tripProgress`, and passes `tripProgress.progressPercent` (**0-100**) to the progress bar at line 1307. On its `<RideMapView ... />`:

```tsx
        routeProgress={tripProgress.isActive ? tripProgress.progressPercent / 100 : null}
```

Gating on `isActive` matters: the hook only tracks progress during `in_progress` / `arrived_at_destination`, and outside that window `progressPercent` is stale rather than meaningful. Do not call `useTripProgress` a second time.

- [ ] **Step 4: Verify**

Run: `pnpm check-types` → 10/10
Run: `pnpm --filter client test` → 35 passed
Run: `pnpm --filter client lint` → 0 errors, ≤66 warnings

- [ ] **Step 5: Commit**

```bash
git add apps/client
git commit -m "feat(client): paint the part of the route already travelled"
```

---

## Task 5: Full verification

- [ ] `pnpm check-types` → `Tasks: 10 successful, 10 total`
- [ ] `pnpm --filter @tricigo/utils test` → 643 passed (634 + 9)
- [ ] `pnpm --filter client test` → 35 passed
- [ ] `pnpm --filter client lint` → 0 errors, warnings ≤ 66
- [ ] `pnpm check:i18n` → no missing translations

---

## Known risk to settle on the device

`lineTrimOffset` is a newer Mapbox GL Native style property. The source now carries `lineMetrics` (which it genuinely requires — see the verified facts), but if the native SDK bundled with this Expo version still ignores the property, the progress layer paints the **whole** route green instead of just the travelled part. That is immediately visible and worse than not shipping it, so check this first. Fallback: drop the layer and revisit with `lineGradient`, which uses the same `lineMetrics` flag.

## On-device checklist (the user runs this)

1. **Vehicles glide.** Use the test-vehicle toggle in vehicle selection (dev/demo builds). They should slide continuously, not hop every second, and point where they're going.
2. **They arrive and leave softly** — no popping in or out.
3. **ETA bubble** rides above the driver during an active ride and tracks them as they move.
4. **Route progress** paints behind the driver only. If the whole line turns green, that's the `lineTrimOffset` risk above.
5. Background the app mid-ride and return — motion resumes, nothing is stuck.
6. **The driver app is untouched.**
