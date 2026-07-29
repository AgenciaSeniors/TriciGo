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
// This module imports `leaflet` at the top level, which touches `window`
// — it MUST only be loaded via next/dynamic with ssr:false (page.tsx).
// ============================================================

import { useMemo } from 'react';
import L from 'leaflet';
import { Marker } from 'react-leaflet';
import type { VehicleType } from '@tricigo/types';

const BADGE = 38; // px — outer badge (>= 44px would be ideal touch size, but leaflet hit area includes the ring/shadow padding)
const VEHICLE = 26; // px — vehicle image inside

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
  /** Popup content (react-leaflet <Popup>). */
  children?: React.ReactNode;
}

export default function DriverVehicleMarker({
  lat,
  lng,
  vehicleType,
  color,
  heading,
  children,
}: DriverVehicleMarkerProps) {
  // Round the heading so GPS jitter doesn't rebuild the icon every tick.
  const roundedHeading = heading == null ? null : Math.round(heading / 15) * 15;

  const icon = useMemo(() => {
    const rotate =
      roundedHeading == null ? '' : `transform: rotate(${roundedHeading}deg);`;
    return L.divIcon({
      // Empty className kills Leaflet's default white-box divIcon styles.
      className: '',
      html: `
        <div style="
          width: ${BADGE}px; height: ${BADGE}px;
          border-radius: 50%;
          background: #fff;
          border: 3px solid ${color};
          box-shadow: 0 1px 4px rgba(0,0,0,0.4);
          display: flex; align-items: center; justify-content: center;
          box-sizing: border-box;
        ">
          <img
            src="${VEHICLE_MARKER_SRC[vehicleType]}"
            alt=""
            width="${VEHICLE}" height="${VEHICLE}"
            style="display: block; ${rotate}"
          />
        </div>`,
      iconSize: [BADGE, BADGE],
      iconAnchor: [BADGE / 2, BADGE / 2],
      popupAnchor: [0, -BADGE / 2],
    });
  }, [vehicleType, color, roundedHeading]);

  return (
    <Marker position={[lat, lng]} icon={icon}>
      {children}
    </Marker>
  );
}
