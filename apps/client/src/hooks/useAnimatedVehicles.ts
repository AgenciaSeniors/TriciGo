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
