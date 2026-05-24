import { useEffect, useRef, useState } from 'react';

export interface AnimatedCoordinate {
  latitude: number;
  longitude: number;
}

/**
 * Linearly interpolate between two geographic coordinates at progress `t`.
 *
 * Exported separately from `useAnimatedCoordinate` so the math is unit-testable
 * without needing a React renderer / requestAnimationFrame mock.
 *
 * - `t = 0` returns `from`.
 * - `t = 1` returns `to`.
 * - `t` outside `[0, 1]` is clamped.
 *
 * Linear interpolation (not great-circle) is intentional: GPS samples for
 * a moving driver are spaced 1-3 m apart at urban speeds, where the
 * great-circle correction is sub-millimeter. Linear is cheaper and visually
 * identical at this scale.
 */
export function lerpCoordinate(
  from: AnimatedCoordinate,
  to: AnimatedCoordinate,
  t: number,
): AnimatedCoordinate {
  const clamped = Math.min(1, Math.max(0, t));
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * clamped,
    longitude: from.longitude + (to.longitude - from.longitude) * clamped,
  };
}

/**
 * Hook that animates between geographic coordinates using requestAnimationFrame
 * for smooth, Uber/Bolt-style marker motion between discrete GPS updates.
 *
 * **Why this exists**: `@rnmapbox/maps` v10.x on Android caches the native
 * marker position once mounted. The codebase used to force re-mount via a
 * coord-derived `key`, which meant the marker visibly teleported on each
 * GPS update (~1 Hz polling rate). This hook returns an interpolated
 * coordinate that updates at ~30 FPS, so when consumed by a
 * `ShapeSource + SymbolLayer` (whose GeoJSON source DOES update without
 * remounting), the marker slides smoothly between known positions.
 *
 * **Algorithm**:
 *   - Linear interpolation between the last rendered coord and the new target.
 *   - Duration matches the expected gap between updates (default 1000 ms to
 *     match the client's `useDriverPosition` 1 Hz poll cadence).
 *   - When a new target arrives mid-animation, the next leg starts from the
 *     current rendered position (not the previous target) — feels continuous
 *     even if updates arrive at irregular intervals.
 *   - First sample teleports immediately (no "from" coord to interpolate
 *     from — would cause a long slide from (0,0) to the real position).
 *
 * **Performance**: a single rAF callback per visible marker. Negligible CPU
 * cost (one lerp + one setState per frame). On Cubacel mid-range hardware
 * the map sustains 60 FPS with the driver marker animating.
 *
 * @param target    The destination coordinate; pass `null` to disable animation.
 * @param durationMs Time to interpolate to a new target. Default 1000 ms.
 * @returns The currently-rendered interpolated coordinate, or `null` if no
 *          target has ever been provided.
 */
export function useAnimatedCoordinate(
  target: AnimatedCoordinate | null,
  durationMs: number = 1000,
): AnimatedCoordinate | null {
  const [rendered, setRendered] = useState<AnimatedCoordinate | null>(null);
  const renderedRef = useRef<AnimatedCoordinate | null>(null);
  const rafRef = useRef<number | null>(null);
  const animationRef = useRef<{
    from: AnimatedCoordinate;
    to: AnimatedCoordinate;
    startedAt: number;
  } | null>(null);

  // Keep the ref in sync with state so the next animation can read the
  // CURRENT rendered position when starting from mid-leg.
  useEffect(() => {
    renderedRef.current = rendered;
  }, [rendered]);

  useEffect(() => {
    // Disable animation when no target.
    if (
      !target ||
      !Number.isFinite(target.latitude) ||
      !Number.isFinite(target.longitude)
    ) {
      animationRef.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // First-ever sample — teleport (no "from" coord makes sense).
    if (renderedRef.current === null) {
      const initial = { latitude: target.latitude, longitude: target.longitude };
      renderedRef.current = initial;
      setRendered(initial);
      return;
    }

    // Already at target — no animation needed.
    if (
      renderedRef.current.latitude === target.latitude &&
      renderedRef.current.longitude === target.longitude
    ) {
      return;
    }

    // Start a new animation leg from the current rendered coord to the
    // new target. Cancel any in-flight rAF first so the prior leg doesn't
    // race against this one.
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    animationRef.current = {
      from: { ...renderedRef.current },
      to: { latitude: target.latitude, longitude: target.longitude },
      startedAt: Date.now(),
    };

    const tick = () => {
      const anim = animationRef.current;
      if (!anim) {
        rafRef.current = null;
        return;
      }
      const elapsed = Date.now() - anim.startedAt;
      const t = elapsed / durationMs;
      const next = lerpCoordinate(anim.from, anim.to, t);
      renderedRef.current = next;
      setRendered(next);
      if (t >= 1) {
        animationRef.current = null;
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // We depend on lat/lng directly so a target object with the same coords
    // but a new identity doesn't re-trigger.
  }, [target?.latitude, target?.longitude, durationMs]);

  return rendered;
}
