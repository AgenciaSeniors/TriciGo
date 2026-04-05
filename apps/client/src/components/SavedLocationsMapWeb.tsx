import React, { useEffect, useRef, useCallback } from 'react';
import { View, Platform } from 'react-native';
import { logger, HAVANA_CENTER, reverseGeocode } from '@tricigo/utils';

// Only import mapbox-gl on web
let mapboxgl: typeof import('mapbox-gl') | null = null;
if (Platform.OS === 'web') {
  try {
    mapboxgl = require('mapbox-gl');
  } catch {
    logger.warn('[SavedLocationsMapWeb] mapbox-gl not available');
  }
}

// Inject mapbox-gl CSS
function ensureMapboxCSS() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('mapbox-gl-css')) return;
  const link = document.createElement('link');
  link.id = 'mapbox-gl-css';
  link.rel = 'stylesheet';
  link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.20.0/mapbox-gl.css';
  document.head.appendChild(link);
}

interface SavedLocation {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface Props {
  locations: SavedLocation[];
  selectMode?: boolean;
  onMapClick?: (lat: number, lng: number, address: string) => void;
  selectedIndex?: number | null;
  height?: number;
}

function getMarkerColor(label: string): string {
  const lower = label.toLowerCase();
  if (lower === 'casa' || lower === 'home') return '#38a169';
  if (lower === 'trabajo' || lower === 'work') return '#3182ce';
  return '#FF4D00';
}

function createMarkerEl(label: string, isSelected: boolean): HTMLDivElement {
  const color = getMarkerColor(label);
  const size = isSelected ? 36 : 30;
  const el = document.createElement('div');
  el.style.cursor = 'pointer';
  el.innerHTML = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      <div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:${color};border:3px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
        display:flex;align-items:center;justify-content:center;
        color:white;font-weight:700;font-size:${isSelected ? 14 : 12}px;
        transition:all 0.2s ease;
      ">${label[0]?.toUpperCase() || '?'}</div>
      <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid ${color};margin-top:-1px;"></div>
    </div>`;
  return el;
}

function createClickMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      <div style="position:absolute;width:40px;height:40px;border-radius:50%;background:rgba(255,77,0,0.2);animation:slm-pulse 1.5s ease-out infinite;top:-5px;left:-5px;"></div>
      <div style="width:30px;height:30px;border-radius:50%;background:#FF4D00;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:16px;">+</div>
      <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #FF4D00;margin-top:-1px;"></div>
    </div>
    <style>@keyframes slm-pulse { 0% { transform:scale(0.8);opacity:1; } 100% { transform:scale(2);opacity:0; } }</style>`;
  return el;
}

export default function SavedLocationsMapWeb({ locations, selectMode, onMapClick, selectedIndex, height = 260 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const clickMarkerRef = useRef<mapboxgl.Marker | null>(null);

  // Initialize map
  useEffect(() => {
    if (!mapboxgl || !containerRef.current || mapRef.current) return;
    ensureMapboxCSS();
    mapboxgl.accessToken = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [HAVANA_CENTER.longitude, HAVANA_CENTER.latitude],
      zoom: 13,
      attributionControl: false,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => map.resize());
    mapRef.current = map;

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Handle map clicks in select mode
  const handleMapClick = useCallback(async (e: mapboxgl.MapMouseEvent) => {
    if (!onMapClick || !mapRef.current || !mapboxgl) return;
    const { lat, lng } = e.lngLat;

    if (clickMarkerRef.current) clickMarkerRef.current.remove();
    clickMarkerRef.current = new mapboxgl.Marker({ element: createClickMarkerEl(), anchor: 'bottom' })
      .setLngLat([lng, lat])
      .addTo(mapRef.current);

    const address = await reverseGeocode(lat, lng) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    onMapClick(lat, lng, address);
  }, [onMapClick]);

  // Toggle select mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (selectMode) {
      map.getCanvas().style.cursor = 'crosshair';
      map.on('click', handleMapClick);
    } else {
      map.getCanvas().style.cursor = '';
      map.off('click', handleMapClick);
      if (clickMarkerRef.current) {
        clickMarkerRef.current.remove();
        clickMarkerRef.current = null;
      }
    }
    return () => { map.off('click', handleMapClick); };
  }, [selectMode, handleMapClick]);

  // Update markers when locations change
  useEffect(() => {
    if (!mapboxgl || !mapRef.current) return;
    const map = mapRef.current;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    if (locations.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();
    locations.forEach((loc, i) => {
      if (!loc.latitude || !loc.longitude) return;
      const marker = new mapboxgl.Marker({
        element: createMarkerEl(loc.label, selectedIndex === i),
        anchor: 'bottom',
      })
        .setLngLat([loc.longitude, loc.latitude])
        .addTo(map);
      markersRef.current.push(marker);
      bounds.extend([loc.longitude, loc.latitude]);
    });

    if (locations.length === 1) {
      map.flyTo({ center: [locations[0].longitude, locations[0].latitude], zoom: 15, duration: 800 });
    } else {
      map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 800 });
    }
  }, [locations, selectedIndex]);

  if (Platform.OS !== 'web' || !mapboxgl) {
    return <View style={{ height, backgroundColor: '#e5e5e5', borderRadius: 16 }} />;
  }

  return (
    <View style={{ height, borderRadius: 16, overflow: 'hidden', marginBottom: 16, borderWidth: selectMode ? 2 : 1, borderColor: selectMode ? '#FF4D00' : '#e5e7eb' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </View>
  );
}
