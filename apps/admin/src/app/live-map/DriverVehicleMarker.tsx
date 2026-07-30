'use client';

// ============================================================
// TriciGo Admin — live-map driver marker with the vehicle on it
//
// Renders a Leaflet divIcon: a white circular badge whose RING carries
// the driver-state color, with the top-down vehicle render centered on
// it, rotated by current_heading. The vehicle art is the SAME set the
// rider app shows on its map (apps/client/assets/vehicles/markers/*,
// copied to /public/vehicles) — including the almendrón for 'auto'
// (BUG-218) — so admin and rider see the same fleet.
//
// Why a white badge + colored ring instead of a solid colored dot with
// the vehicle on top: the vehicle renders are TriciGo orange, and one of
// the state colors (in_progress) is also orange — the vehicle would
// disappear into its own state color. White maximizes contrast on any
// tile and in both themes; the state stays prominent in the ring.
//
// Size comes from the caller (markerSize.ts) because divIcons are fixed
// pixels and must be re-tiered per zoom level.
//
// This module imports `leaflet` at the top level, which touches `window`
// — it MUST only be loaded via next/dynamic with ssr:false (page.tsx).
// ============================================================

import { useMemo } from 'react';
import L from 'leaflet';
import { Marker } from 'react-leaflet';
import type { VehicleType } from '@tricigo/types';
import type { MarkerSize } from './markerSize';

/** Files under apps/admin/public/vehicles/. 'auto' is auto_clasico
    (the Cuban almendrón), mirroring the rider map's choice. */
const VEHICLE_MARKER_SRC: Record<VehicleType, string> = {
  triciclo: '/vehicles/triciclo.png',
  moto: '/vehicles/moto.png',
  auto: '/vehicles/auto.png',
  confort: '/vehicles/confort.png',
};

interface DriverVehicleMarkerProps {
  lat: number;
  lng: number;
  vehicleType: VehicleType;
  /** Driver-state color — painted on the badge ring. */
  color: string;
  /** 0-359° clockwise from north; null → no rotation. The marker art
      faces north ("up"), same convention as the rider map. */
  heading: number | null;
  /** Badge/vehicle/border px for the current zoom (markerSizeForZoom). */
  size: MarkerSize;
  /** Popup content (react-leaflet <Popup>). */
  children?: React.ReactNode;
}

export default function DriverVehicleMarker({
  lat,
  lng,
  vehicleType,
  color,
  heading,
  size,
  children,
}: DriverVehicleMarkerProps) {
  // Round the heading so GPS jitter doesn't rebuild the icon every tick.
  const roundedHeading = heading == null ? null : Math.round(heading / 15) * 15;
  const { badge, vehicle, border } = size;

  const icon = useMemo(() => {
    const rotate =
      roundedHeading == null ? '' : `transform: rotate(${roundedHeading}deg);`;
    // The vehicle size MUST be an inline style with !important, NOT the
    // `width`/`height` HTML attributes. Those attributes are only
    // presentational hints and lose to ANY author CSS rule — and
    // leaflet.css ships
    //   `.leaflet-container .leaflet-marker-pane img { width: auto }`
    // (plus Tailwind preflight's `img { height: auto }`), which made the
    // image render at its natural 96px inside a 38px badge and spill all
    // over the map. Measured, not guessed. Do not "simplify" this back
    // into width=/height= attributes.
    const sizing = `width: ${vehicle}px !important; height: ${vehicle}px !important;`;
    return L.divIcon({
      // Empty className kills Leaflet's default white-box divIcon styles.
      className: '',
      html: `
        <div style="
          width: ${badge}px; height: ${badge}px;
          border-radius: 50%;
          background: #fff;
          border: ${border}px solid ${color};
          box-shadow: 0 1px 4px rgba(0,0,0,0.4);
          display: flex; align-items: center; justify-content: center;
          box-sizing: border-box;
          overflow: hidden;
        ">
          <img src="${VEHICLE_MARKER_SRC[vehicleType]}" alt="" style="display: block; ${sizing} ${rotate}" />
        </div>`,
      iconSize: [badge, badge],
      iconAnchor: [badge / 2, badge / 2],
      popupAnchor: [0, -badge / 2],
    });
  }, [vehicleType, color, roundedHeading, badge, vehicle, border]);

  return (
    <Marker position={[lat, lng]} icon={icon}>
      {children}
    </Marker>
  );
}
