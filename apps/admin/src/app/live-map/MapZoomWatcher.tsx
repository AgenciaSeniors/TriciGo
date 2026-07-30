'use client';

// ============================================================
// TriciGo Admin — live-map zoom reporter
//
// Leaflet's zoom lives inside the map instance, not in React state, and
// react-leaflet's hooks only work for components rendered INSIDE
// <MapContainer>. This is that component: it renders nothing and just
// pushes the current zoom up so the page can pick a marker size tier
// (see markerSize.ts).
//
// Imports react-leaflet (→ leaflet → `window`), so it must be loaded
// via next/dynamic with ssr:false.
// ============================================================

import { useEffect } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';

interface MapZoomWatcherProps {
  onZoomChange: (zoom: number) => void;
}

export default function MapZoomWatcher({ onZoomChange }: MapZoomWatcherProps) {
  const map = useMap();

  // Seed with the zoom the map mounted at (no zoom event fires for it).
  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);

  useMapEvents({
    zoomend: (e) => onZoomChange(e.target.getZoom()),
  });

  return null;
}
