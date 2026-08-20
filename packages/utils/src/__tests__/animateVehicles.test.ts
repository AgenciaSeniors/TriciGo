import { describe, it, expect } from 'vitest';
import { stepVehicles, type VehicleTarget } from '../animateVehicles';

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
    const h = mid.rendered[0]!.heading;
    expect(Math.min(Math.abs(h - 0), Math.abs(h - 360))).toBeLessThan(3);
  });

  it('ignores targets with unusable coordinates', () => {
    const bad: VehicleTarget = { ...A, id: 'bad', latitude: NaN };
    const { rendered } = stepVehicles(new Map(), [bad], 0, OPTS);
    expect(rendered).toHaveLength(0);
  });
});
