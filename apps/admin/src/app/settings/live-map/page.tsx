'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { adminService } from '@tricigo/api/services/admin';
import { useTranslation } from '@tricigo/i18n';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

interface OnlineDriver {
  id: string;
  full_name: string;
  vehicle_type: string;
  latitude: number;
  longitude: number;
  is_online: boolean;
  rating_avg: number;
}

const HAVANA_CENTER: [number, number] = [-82.3666, 23.1136];

const VEHICLE_COLORS: Record<string, string> = {
  triciclo: '#FF4D00',
  moto: '#3b82f6',
  auto: '#22c55e',
  confort: '#8b5cf6',
};

function createDriverMarkerEl(driver: OnlineDriver): HTMLDivElement {
  const color = VEHICLE_COLORS[driver.vehicle_type] ?? '#FF4D00';
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="position:relative;cursor:pointer;">
      <div style="
        width:32px;height:32px;border-radius:50%;
        background:${color};border:3px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
        display:flex;align-items:center;justify-content:center;
        font-size:14px;color:white;font-weight:bold;
      ">${driver.full_name?.charAt(0)?.toUpperCase() ?? '?'}</div>
    </div>`;
  return el;
}

export default function LiveMapPage() {
  const { t } = useTranslation('admin');
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const [drivers, setDrivers] = useState<OnlineDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchDrivers = useCallback(async () => {
    try {
      const data = await adminService.getOnlineDrivers();
      setDrivers(data as OnlineDriver[]);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Error fetching online drivers:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: HAVANA_CENTER,
      zoom: 12,
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Fetch drivers on mount
  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  // Auto-refresh every 15s
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchDrivers, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchDrivers]);

  // Update markers when drivers change
  useEffect(() => {
    if (!mapRef.current) return;

    // Remove old markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // Add new markers
    drivers.forEach((driver) => {
      if (!driver.latitude || !driver.longitude) return;

      const popup = new mapboxgl.Popup({ offset: 20, closeButton: false })
        .setHTML(`
          <div style="font-family:sans-serif;padding:4px;">
            <strong>${driver.full_name ?? 'Sin nombre'}</strong><br/>
            <span style="color:#666;font-size:12px;">${driver.vehicle_type} · ${Number(driver.rating_avg ?? 0).toFixed(1)}★</span>
          </div>
        `);

      const marker = new mapboxgl.Marker({ element: createDriverMarkerEl(driver) })
        .setLngLat([driver.longitude, driver.latitude])
        .setPopup(popup)
        .addTo(mapRef.current!);

      markersRef.current.push(marker);
    });
  }, [drivers]);

  const onlineByType = drivers.reduce<Record<string, number>>((acc, d) => {
    acc[d.vehicle_type] = (acc[d.vehicle_type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <Link href="/settings" className="text-sm text-primary-500 hover:underline mb-4 inline-block">
        &larr; {t('settings.back_to_settings')}
      </Link>

      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold">{t('live_map.title', { defaultValue: 'Mapa en Tiempo Real' })}</h1>
          <p className="text-sm text-neutral-500">
            {drivers.length} {t('live_map.drivers_online', { defaultValue: 'conductores en línea' })}
            {lastUpdated && ` · ${t('surge_dashboard.last_updated')}: ${lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-neutral-500">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            {t('live_map.auto_refresh', { defaultValue: 'Actualizar cada 15s' })}
          </label>
          <button
            onClick={fetchDrivers}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600"
          >
            {loading ? '...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Stats by vehicle type */}
      <div className="flex gap-3 mb-4">
        {Object.entries(onlineByType).map(([type, count]) => (
          <div key={type} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-neutral-100">
            <span
              className="w-3 h-3 rounded-full"
              style={{ background: VEHICLE_COLORS[type] ?? '#999' }}
            />
            <span className="text-sm font-medium capitalize">{type}</span>
            <span className="text-sm text-neutral-500">{count}</span>
          </div>
        ))}
      </div>

      {/* Map */}
      <div
        ref={mapContainerRef}
        style={{ height: 500, width: '100%', borderRadius: '0.75rem', overflow: 'hidden' }}
      />
    </div>
  );
}
