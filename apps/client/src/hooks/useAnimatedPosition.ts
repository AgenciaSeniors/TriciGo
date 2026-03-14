import { useRef, useEffect, useState } from 'react';

interface AnimatedPosition {
  latitude: number;
  longitude: number;
  heading: number;
}

/**
 * Smoothly interpolates between GPS position updates using requestAnimationFrame.
 * Produces ~60fps coordinate updates with ease-out cubic easing.
 *
 * Used to animate the driver marker on the rider's map so it glides
 * between GPS positions instead of jumping.
 *
 * @param rawPosition - Discrete GPS position from useDriverPosition
 * @param duration - Animation duration in ms (default 1000ms)
 * @returns Interpolated position updated every frame, or null if no position
 */
export function useAnimatedPosition(
  rawPosition: { latitude: number; longitude: number; heading?: number | null } | null,
  duration: number = 1000,
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

    const start = prevRef.current ?? target;
    const startTime = Date.now();

    // Cancel any running animation
    if (animFrameRef.current != null) {
      cancelAnimationFrame(animFrameRef.current);
    }

    function animate() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic for natural deceleration
      const eased = 1 - Math.pow(1 - progress, 3);

      const interpolated: AnimatedPosition = {
        latitude: start.latitude + (target.latitude - start.latitude) * eased,
        longitude: start.longitude + (target.longitude - start.longitude) * eased,
        heading: start.heading + (target.heading - start.heading) * eased,
      };

      setCurrent(interpolated);

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        prevRef.current = target;
        animFrameRef.current = null;
      }
    }

    animate();

    return () => {
      if (animFrameRef.current != null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [rawPosition?.latitude, rawPosition?.longitude, rawPosition?.heading, duration]);

  return current;
}
