// ============================================================
// TriciGo — Pre-launch test/preview vehicles
//
// Generates synthetic `NearbyVehicle` markers that move around the
// map so the team can preview how vehicle icons render (type, size,
// heading rotation) without needing real drivers online in Cuba.
//
// Pure math only — no React, no I/O. Both the client and the driver
// apps wrap this in a thin `useTestVehicles` hook gated to dev/demo
// builds. Nothing here ever touches the database or the live
// `find_nearby_vehicles` RPC.
// ============================================================

import type { NearbyVehicle, VehicleType } from '@tricigo/types';

/** Vehicle types that map to a `marker-*` icon in RideMapView. */
export const TEST_VEHICLE_TYPES: VehicleType[] = [
  'triciclo',
  'moto',
  'auto',
  'confort',
];

/** Plausible cruising speed per type (meters per second). */
const SPEED_BY_TYPE_MPS: Record<VehicleType, number> = {
  triciclo: 4, // ~14 km/h
  moto: 9, // ~32 km/h
  auto: 7, // ~25 km/h
  confort: 7,
};

/**
 * A test vehicle is a real `NearbyVehicle` plus internal motion state
 * used by `stepTestVehicles`. The extra fields are ignored by the map
 * renderer, so a `TestVehicle[]` is safely usable wherever a
 * `NearbyVehicle[]` is expected.
 */
export interface TestVehicle extends NearbyVehicle {
  _speedMps: number;
}

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Distance in meters between two lat/lng points (equirectangular — fine at city scale). */
function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (a.lat - b.lat) * METERS_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * metersPerDegLng(a.lat);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Bearing in degrees (0 = north, clockwise) from `from` toward `to`. */
function bearingTo(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const dLat = (to.lat - from.lat) * METERS_PER_DEG_LAT;
  const dLng = (to.lng - from.lng) * metersPerDegLng(from.lat);
  const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Spread `count` test vehicles in a ring (~150–700 m) around `center`,
 * cycling through the four marker vehicle types for visual variety.
 * Each gets a random heading and a per-type cruising speed.
 */
export function generateTestVehicles(
  center: { lat: number; lng: number },
  count = 8,
): TestVehicle[] {
  const vehicles: TestVehicle[] = [];
  const mPerLng = metersPerDegLng(center.lat);

  for (let i = 0; i < count; i++) {
    const type = TEST_VEHICLE_TYPES[i % TEST_VEHICLE_TYPES.length]!;
    const angle = (i / count) * 2 * Math.PI + Math.random() * 0.5;
    const radiusM = 150 + Math.random() * 550;
    const offsetLat = (Math.cos(angle) * radiusM) / METERS_PER_DEG_LAT;
    const offsetLng = (Math.sin(angle) * radiusM) / mPerLng;

    vehicles.push({
      driver_profile_id: `test-veh-${i}`,
      latitude: center.lat + offsetLat,
      longitude: center.lng + offsetLng,
      heading: Math.floor(Math.random() * 360),
      vehicle_type: type,
      custom_per_km_rate_cup: null,
      _speedMps: SPEED_BY_TYPE_MPS[type],
    });
  }
  return vehicles;
}

/**
 * Advance every vehicle `_speedMps * dtSeconds` meters along its
 * heading, applying a small random turn for organic motion. Vehicles
 * that drift past `maxRadiusM` from `center` are steered back toward it
 * so they stay on screen. Returns a fresh array (immutable update).
 */
export function stepTestVehicles(
  vehicles: TestVehicle[],
  dtSeconds: number,
  center: { lat: number; lng: number },
  maxRadiusM = 800,
): TestVehicle[] {
  const mPerLng = metersPerDegLng(center.lat);

  return vehicles.map((v) => {
    const pos = { lat: v.latitude, lng: v.longitude };
    let heading = v.heading ?? 0;

    // If too far from center, point back toward it; otherwise wander.
    if (distanceM(pos, center) > maxRadiusM) {
      heading = bearingTo(pos, center);
    } else {
      heading = (heading + (Math.random() - 0.5) * 20 + 360) % 360;
    }

    const stepM = v._speedMps * dtSeconds;
    const rad = (heading * Math.PI) / 180;
    const dLat = (Math.cos(rad) * stepM) / METERS_PER_DEG_LAT;
    const dLng = (Math.sin(rad) * stepM) / mPerLng;

    return {
      ...v,
      latitude: v.latitude + dLat,
      longitude: v.longitude + dLng,
      heading,
    };
  });
}
