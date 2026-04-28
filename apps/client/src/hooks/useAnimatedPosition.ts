import { useRef, useEffect, useState } from 'react';

interface AnimatedPosition {
  latitude: number;
  longitude: number;
  heading: number;
}

interface RawPosition {
  latitude: number;
  longitude: number;
  heading?: number | null;
  // BUG-256 left these here so a future implementation can dead-reckon if
  // we want — they are accepted but currently unused (see BUG-259 below).
  speed?: number | null;
  recordedAt?: number;
}

/**
 * Smoothly interpolates the driver marker between GPS samples at 60fps.
 *
 * BUG-259 — KEEP THE MARKER ON THE ROAD:
 *   The previous version (BUG-256 v2) added "dead-reckoning" — after the
 *   interpolation finished, the marker kept moving forward in the last-known
 *   heading at the last-known speed, indefinitely. The intent was to mask
 *   network jitter so the marker never freezes. The reality, observed in
 *   user testing, was that the marker would drive STRAIGHT through buildings
 *   and empty space whenever the driver took a turn, then snap back to the
 *   road when the next sample arrived.
 *
 *   Why: the projection used the heading from the previous sample, which
 *   pre-dated the turn. With samples 1s apart, on a network drop the marker
 *   could drift 20–80 m off the road in the wrong direction. That looks
 *   broken.
 *
 *   Fix: drop dead-reckoning entirely. Use a single-phase linear interpolation
 *   that runs for `duration` ms (defaults to 1.2 s, slightly longer than the
 *   1 s poll interval so consecutive samples produce overlapping animations
 *   and the marker never appears to freeze even with mild jitter). Once the
 *   interpolation completes, the marker rests at the latest known sample
 *   until the next one arrives. This stays ON the polyline of consecutive
 *   GPS fixes — which is, by definition, ON the road.
 *
 *   Trade-off: brief perceived "pause" between samples on a long network
 *   gap. Acceptable: pausing on the road > drifting through buildings.
 *
 *   Heading uses shortest-arc interpolation to avoid the 359°→1° spin.
 *
 * @param rawPosition - Discrete GPS position from useDriverPosition
 * @param duration - Interpolation window (ms). Default 1200 — slightly
 *                   longer than the 1 s poll interval to overlap samples.
 * @returns Interpolated position updated every animation frame
 */
export function useAnimatedPosition(
  rawPosition: RawPosition | null,
  duration: number = 1200,
): AnimatedPosition | null {
  const [current, setCurrent] = useState<AnimatedPosition | null>(null);
  const prevRef = useRef<AnimatedPosition | null>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!rawPosition) {
      setCurrent(null);
      prevRef.current = null;
      return;
    }

    const target: AnimatedPosition = {
      latitude: rawPosition.latitude,
      longitude: rawPosition.longitude,
      heading: rawPosition.heading ?? 0,
    };

    // First sample after a null state: snap immediately, no interpolation.
    if (!prevRef.current) {
      prevRef.current = target;
      setCurrent(target);
      return;
    }

    const start = prevRef.current;
    const startTime = Date.now();

    if (animFrameRef.current != null) {
      cancelAnimationFrame(animFrameRef.current);
    }

    function animate() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Shortest-arc heading interpolation (handles 359°→1° wrap-around).
      const dh = ((target.heading - start.heading + 540) % 360) - 180;
      const heading = (start.heading + dh * progress + 360) % 360;

      const interpolated: AnimatedPosition = {
        latitude: start.latitude + (target.latitude - start.latitude) * progress,
        longitude: start.longitude + (target.longitude - start.longitude) * progress,
        heading,
      };

      // BUG-266: keep prevRef tracking the VISUAL position, not the target.
      // When a new sample arrives mid-animation, the next effect run starts
      // animating from where the marker actually is on screen instead of
      // teleporting to the previous target.
      prevRef.current = interpolated;
      setCurrent(interpolated);

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Interpolation complete — rest at target until the next sample.
        // BUG-259: do NOT extrapolate forward. The marker stays on the
        // polyline of real fixes, which is the road.
        animFrameRef.current = null;
      }
    }

    animate();

    return () => {
      // BUG-266: do NOT overwrite prevRef here — animate() keeps it in sync
      // with the actual visual position every frame. Just cancel the frame.
      if (animFrameRef.current != null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [rawPosition?.latitude, rawPosition?.longitude, rawPosition?.heading, rawPosition?.recordedAt, duration]);

  return current;
}
