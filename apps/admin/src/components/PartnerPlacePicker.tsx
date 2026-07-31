'use client';

// ============================================================
// Map picker for /admin/partners.
//
// Stack: react-leaflet, matching /live-map. NOT mapbox-gl — the admin's other
// map already runs on Leaflet and needs no token.
//
// This module imports react-leaflet (→ leaflet → `window`) at the top level,
// so it MUST be loaded from the page via dynamic(..., { ssr: false }).
// Same contract as live-map/DriverVehicleMarker.tsx.
//
// Leaflet's stylesheet comes from the same unpkg <link> live-map uses rather
// than `import 'leaflet/dist/leaflet.css'`: leaflet is not a declared
// dependency of @tricigo/admin (it resolves out of the workspace root, where
// apps/web declares it), so a bare CSS specifier would be a phantom import
// that only fails at `next build`. React hoists the <link> into <head> and
// dedupes it against live-map's identical URL.
// ============================================================

import { MapContainer, TileLayer, CircleMarker, Circle, useMapEvents } from 'react-leaflet';

interface Props {
  latitude: number;
  longitude: number;
  radiusM: number;
  onChange: (lat: number, lng: number) => void;
}

function ClickCapture({ onChange }: { onChange: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onChange(e.latlng.lat, e.latlng.lng) });
  return null;
}

/**
 * Click the map to place the business. The shaded circle is the real match
 * radius — an admin who sets 500 m can see it swallowing the whole block
 * before saving, instead of discovering it through spurious coupons.
 */
export default function PartnerPlacePicker({ latitude, longitude, radiusM, onChange }: Props) {
  return (
    <div className="h-64 overflow-hidden rounded-lg border border-line">
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      {/* `center` is read once, on mount. That is deliberate: re-centring on
          every click would fight the admin's panning. The marker below does
          follow the coordinates. */}
      <MapContainer
        center={[latitude, longitude]}
        zoom={16}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        <ClickCapture onChange={onChange} />
        <Circle
          center={[latitude, longitude]}
          radius={radiusM}
          pathOptions={{ color: '#FF4D00', fillOpacity: 0.12, weight: 1 }}
        />
        <CircleMarker
          center={[latitude, longitude]}
          radius={7}
          pathOptions={{ color: '#FF4D00', fillColor: '#FF4D00', fillOpacity: 1 }}
        />
      </MapContainer>
    </div>
  );
}
