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
