'use client';

// Map picker for the "add a stop mid-ride" flow. Mirrors the click-to-place +
// reverseGeocode pattern of apps/web/src/app/profile/saved-locations/
// SavedLocationsMap.tsx, but as a self-contained modal that returns a single
// { address, latitude, longitude } on confirm — fed into the same
// handleSelectStop the address-search path uses.

import { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { reverseGeocode } from '@tricigo/utils';
import { MAPBOX_TOKEN, HAS_MAPBOX_TOKEN } from '@/config/mapbox';
import { MapUnavailable } from '@/components/MapUnavailable';

mapboxgl.accessToken = MAPBOX_TOKEN;

interface StopPickerMapProps {
  /** Initial map center (usually the ride's pickup). */
  center: { latitude: number; longitude: number };
  onConfirm: (stop: { address: string; latitude: number; longitude: number }) => void;
  onClose: () => void;
}

export function StopPickerMap({ center, onConfirm, onClose }: StopPickerMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const [selected, setSelected] = useState<{ address: string; latitude: number; longitude: number } | null>(null);
  const [resolving, setResolving] = useState(false);

  const placeAt = useCallback(async (lat: number, lng: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) markerRef.current.remove();
    markerRef.current = new mapboxgl.Marker({ color: '#FF4D00', anchor: 'bottom' })
      .setLngLat([lng, lat])
      .addTo(map);
    setResolving(true);
    const address = (await reverseGeocode(lat, lng)) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    setSelected({ address, latitude: lat, longitude: lng });
    setResolving(false);
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const validCenter = Number.isFinite(center.latitude) && Number.isFinite(center.longitude) && center.latitude !== 0;
    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: validCenter ? [center.longitude, center.latitude] : [-82.3666, 23.1136],
        zoom: 14,
        attributionControl: false,
      });
    } catch (err) {
      console.error('[StopPickerMap] Mapbox init failed:', err);
      return;
    }
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.getCanvas().style.cursor = 'crosshair';
    map.on('click', (e) => { placeAt(e.lngLat.lat, e.lngLat.lng); });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--bg-card, #fff)', borderRadius: 16, overflow: 'hidden', maxWidth: 480, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-light)' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Marcar parada en el mapa</h3>
          <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>Toca el mapa para elegir el punto.</p>
        </div>
        {HAS_MAPBOX_TOKEN
          ? <div ref={containerRef} style={{ width: '100%', height: 320 }} />
          : <div style={{ width: '100%', height: 320 }}><MapUnavailable /></div>}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-light)' }}>
          <p style={{ margin: '0 0 10px', fontSize: '0.82rem', color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)', minHeight: '1.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {resolving ? 'Buscando dirección…' : selected ? `📍 ${selected.address}` : 'Sin punto seleccionado'}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ flex: 1, padding: '0.7rem', borderRadius: '0.6rem', border: '1px solid var(--border)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!selected || resolving}
              onClick={() => { if (selected) onConfirm(selected); }}
              style={{ flex: 1, padding: '0.7rem', borderRadius: '0.6rem', border: 'none', background: 'var(--primary, #FF4D00)', color: '#fff', cursor: selected && !resolving ? 'pointer' : 'not-allowed', opacity: selected && !resolving ? 1 : 0.6, fontSize: '0.85rem', fontWeight: 700 }}
            >
              Confirmar parada
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
