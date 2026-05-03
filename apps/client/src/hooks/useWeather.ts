import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeCubanCityLabel } from '@tricigo/utils';

export type WeatherData = {
  tempC: number;
  description: string;
  conditionCode: number;
  city: string | null;
};

type CacheEntry = WeatherData & { lat: number; lon: number; cachedAt: number };

const CACHE_KEY = '@tricigo/weather_cache';
const CACHE_TTL_MS = 30 * 60 * 1000;
const COORD_TOLERANCE = 0.05;
const FETCH_TIMEOUT_MS = 5000;

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const WWO_TO_OWM: Record<number, number> = {
  113: 800, 116: 802, 119: 804, 122: 804,
  143: 741, 248: 741, 260: 741,
  176: 500, 263: 500, 266: 500, 293: 500, 296: 500,
  299: 501, 302: 501, 305: 502, 308: 502, 356: 502, 359: 502,
  200: 211, 386: 211, 389: 211, 392: 211, 395: 211,
};

function mapWwoToOwm(w: number): number {
  return WWO_TO_OWM[w] ?? 800;
}

async function fetchWeatherFromWttr(lat: number, lon: number): Promise<{ tempC: number; description: string; conditionCode: number } | null> {
  try {
    const url = `https://wttr.in/${lat.toFixed(3)},${lon.toFixed(3)}?format=j1`;
    const res = await fetch(url, {
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'TriciGo/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) return null;
    const wwoCode = parseInt(current.weatherCode, 10);
    return {
      tempC: parseFloat(current.temp_C) || 0,
      description: current.weatherDesc?.[0]?.value ?? '',
      conditionCode: mapWwoToOwm(wwoCode),
    };
  } catch {
    return null;
  }
}

async function fetchCityFromMapbox(lat: number, lon: number): Promise<string | null> {
  const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
  if (!token) return null;
  try {
    const url =
      `https://api.mapbox.com/search/geocode/v6/reverse` +
      `?longitude=${lon}&latitude=${lat}&language=es&types=place,locality&limit=1` +
      `&access_token=${token}`;
    const res = await fetch(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const feature = data?.features?.[0];
    if (!feature) return null;
    const ctx = feature.properties?.context ?? {};
    const raw = ctx.place?.name || ctx.locality?.name || feature.properties?.name || null;
    return normalizeCubanCityLabel(raw);
  } catch {
    return null;
  }
}

export function useWeather(coords: { latitude: number; longitude: number } | null): { data: WeatherData | null; loading: boolean } {
  const [data, setData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!coords) return;
    let cancelled = false;

    (async () => {
      try {
        const cachedRaw = await AsyncStorage.getItem(CACHE_KEY);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw) as CacheEntry;
          const ageMs = Date.now() - cached.cachedAt;
          const sameSpot =
            Math.abs(cached.lat - coords.latitude) < COORD_TOLERANCE &&
            Math.abs(cached.lon - coords.longitude) < COORD_TOLERANCE;
          if (ageMs < CACHE_TTL_MS && sameSpot) {
            if (!cancelled) {
              setData({
                tempC: cached.tempC,
                description: cached.description,
                conditionCode: cached.conditionCode,
                // Re-normalize on read so users who already have
                // "Provincia de ..." cached from a previous app version
                // see the cleaned label instantly, not after the 30-min
                // TTL flips.
                city: normalizeCubanCityLabel(cached.city),
              });
            }
            return;
          }
        }
      } catch {
        // ignore malformed cache
      }

      if (cancelled) return;
      setLoading(true);
      try {
        const [weather, city] = await Promise.all([
          fetchWeatherFromWttr(coords.latitude, coords.longitude),
          fetchCityFromMapbox(coords.latitude, coords.longitude),
        ]);
        if (cancelled || !weather) return;
        const result: WeatherData = { ...weather, city };
        setData(result);
        const entry: CacheEntry = {
          ...result,
          lat: coords.latitude,
          lon: coords.longitude,
          cachedAt: Date.now(),
        };
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry)).catch(() => {});
      } catch {
        // fail silently — chip stays hidden
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [coords?.latitude, coords?.longitude]);

  return { data, loading };
}
