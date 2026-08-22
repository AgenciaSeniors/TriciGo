import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { stepVehicles, type AnimatedVehicle, type VehicleAnimState, type VehicleTarget } from '@tricigo/utils';

/** Matches the 1 Hz cadence the demo preview moves vehicles at; real polls
 *  are slower, and a slide that finishes early just sits still. */
const MOVE_MS = 1000;
const FADE_MS = 400;
/** ~30 FPS. Matches the ant-march loop already running in this component. */
const FRAME_MS = 33;

const EMPTY: AnimatedVehicle[] = [];

/**
 * Smooth positions for every nearby vehicle, driven by a single animation
 * loop. `useAnimatedCoordinate` can't do this job — it's a hook, so it
 * can't be called once per vehicle in a list that changes size.
 *
 * Pauses with the app: nobody is watching vehicles glide while backgrounded.
 */
export function useAnimatedVehicles(targets: VehicleTarget[] | null | undefined): AnimatedVehicle[] {
  const [rendered, setRendered] = useState<AnimatedVehicle[]>(EMPTY);
  const stateRef = useRef<Map<string, VehicleAnimState>>(new Map());
  const targetsRef = useRef<VehicleTarget[]>([]);
  const wasEmptyRef = useRef(true);
  targetsRef.current = targets ?? [];

  // Only run the loop where there is something to animate. RideMapView
  // mounts on five screens and just two ever pass vehicles, and Expo Router
  // keeps a tab mounted underneath a pushed screen — so an unconditional
  // loop would wake the JS thread every frame, twice over, to compute
  // nothing. Re-arms as soon as vehicles appear.
  const hasWork = (targets?.length ?? 0) > 0;

  useEffect(() => {
    if (!hasWork && stateRef.current.size === 0) return;

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
        // With nothing left to animate, hand back the SAME empty array and
        // stop: the last departing vehicle has finished fading out.
        if (out.length === 0) {
          if (!wasEmptyRef.current) {
            wasEmptyRef.current = true;
            setRendered(EMPTY);
          }
          if (targetsRef.current.length === 0) {
            stop();
            return;
          }
        } else {
          wasEmptyRef.current = false;
          setRendered(out);
        }
      }
      rafId = requestAnimationFrame(frame);
    };

    const start = () => { if (rafId === null) rafId = requestAnimationFrame(frame); };
    function stop() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => { sub.remove(); stop(); };
  }, [hasWork]);

  return rendered;
}
