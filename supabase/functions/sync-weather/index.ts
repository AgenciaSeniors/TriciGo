// ============================================================
// TriciGo — Sync Weather Edge Function
// Fetches current weather for Havana and creates/updates
// surge_zones entries when bad weather is detected.
//
// Strategy:
//   1. OpenWeatherMap API (if API key configured)
//   2. wttr.in fallback (no API key needed)
//
// Designed to be called via cron every 15 minutes or manually.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CORS ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// ── Havana coordinates ──
const HAVANA_LAT = 23.13;
const HAVANA_LNG = -82.38;

// ── Weather condition → surge multiplier mapping ──
// Based on OpenWeatherMap condition codes:
// https://openweathermap.org/weather-conditions
function getWeatherMultiplier(conditionCode: number): { multiplier: number; reason: string; condition: string } {
  // Thunderstorm (200-232)
  if (conditionCode >= 200 && conditionCode <= 232) {
    return { multiplier: 1.6, reason: 'weather_storm', condition: 'storm' };
  }
  // Drizzle (300-321)
  if (conditionCode >= 300 && conditionCode <= 302) {
    return { multiplier: 1.2, reason: 'weather_drizzle', condition: 'drizzle' };
  }
  if (conditionCode >= 310 && conditionCode <= 321) {
    return { multiplier: 1.3, reason: 'weather_rain', condition: 'rain' };
  }
  // Rain (500-531)
  if (conditionCode >= 500 && conditionCode <= 501) {
    return { multiplier: 1.3, reason: 'weather_rain', condition: 'rain' };
  }
  if (conditionCode >= 502 && conditionCode <= 504) {
    return { multiplier: 1.5, reason: 'weather_heavy_rain', condition: 'heavy_rain' };
  }
  if (conditionCode === 511) {
    return { multiplier: 1.8, reason: 'weather_extreme', condition: 'extreme' };
  }
  if (conditionCode >= 520 && conditionCode <= 531) {
    return { multiplier: 1.4, reason: 'weather_rain', condition: 'rain' };
  }
  // Extreme (771 squall, 781 tornado)
  if (conditionCode === 771 || conditionCode === 781) {
    return { multiplier: 1.8, reason: 'weather_extreme', condition: 'extreme' };
  }
  // Clear/Clouds (800-804) or anything else
  return { multiplier: 1.0, reason: 'weather_clear', condition: 'clear' };
}

// ── Fetch from OpenWeatherMap ──
async function fetchOpenWeatherMap(apiKey: string): Promise<{ code: number; description: string; temp: number } | null> {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${HAVANA_LAT}&lon=${HAVANA_LNG}&appid=${apiKey}&units=metric`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      console.warn(`OpenWeatherMap returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.weather && data.weather.length > 0) {
      return {
        code: data.weather[0].id,
        description: data.weather[0].description,
        temp: data.main?.temp ?? 0,
      };
    }
    return null;
  } catch (err) {
    console.warn('OpenWeatherMap fetch failed:', err);
    return null;
  }
}

// ── Fetch from wttr.in (fallback, no API key needed) ──
async function fetchWttrIn(): Promise<{ code: number; description: string; temp: number } | null> {
  try {
    const url = 'https://wttr.in/Havana?format=j1';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'TriciGo/1.0' },
    });
    if (!res.ok) {
      console.warn(`wttr.in returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) return null;

    // wttr.in uses WWO codes, map to approximate OWM codes
    const wwoCode = parseInt(current.weatherCode, 10);
    const owmCode = mapWwoToOwm(wwoCode);
    return {
      code: owmCode,
      description: current.weatherDesc?.[0]?.value ?? 'Unknown',
      temp: parseFloat(current.temp_C) || 0,
    };
  } catch (err) {
    console.warn('wttr.in fetch failed:', err);
    return null;
  }
}

// Map WWO (World Weather Online) codes to approximate OWM codes
function mapWwoToOwm(wwoCode: number): number {
  // Clear
  if (wwoCode === 113) return 800;
  // Partly cloudy
  if (wwoCode === 116) return 802;
  // Cloudy/Overcast
  if (wwoCode === 119 || wwoCode === 122) return 804;
  // Mist/Fog
  if (wwoCode === 143 || wwoCode === 248 || wwoCode === 260) return 741;
  // Light drizzle/rain
  if (wwoCode === 176 || wwoCode === 263 || wwoCode === 266 || wwoCode === 293 || wwoCode === 296) return 500;
  // Moderate rain
  if (wwoCode === 299 || wwoCode === 302) return 501;
  // Heavy rain
  if (wwoCode === 305 || wwoCode === 308 || wwoCode === 356 || wwoCode === 359) return 502;
  // Thunderstorm
  if (wwoCode === 200 || wwoCode === 386 || wwoCode === 389 || wwoCode === 392 || wwoCode === 395) return 211;
  // Default: clear
  return 800;
}

// ── Main handler ──
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Check if weather surge is enabled
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['openweather_api_key', 'weather_surge_enabled']);

    const configMap = new Map((configs ?? []).map((c: { key: string; value: string }) => [c.key, c.value]));

    const enabled = configMap.get('weather_surge_enabled');
    if (enabled === 'false' || enabled === '"false"') {
      console.log('Weather surge disabled via platform_config');
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'disabled' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Fetch weather data
    let weather: { code: number; description: string; temp: number } | null = null;

    const apiKey = (configMap.get('openweather_api_key') ?? '').replace(/"/g, '');
    if (apiKey && apiKey !== 'YOUR_API_KEY') {
      console.log('Attempting OpenWeatherMap...');
      weather = await fetchOpenWeatherMap(apiKey);
    }

    if (!weather) {
      console.log('Falling back to wttr.in...');
      weather = await fetchWttrIn();
    }

    if (!weather) {
      console.warn('All weather sources failed');
      return new Response(
        JSON.stringify({ ok: false, error: 'All weather sources failed' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`Weather: code=${weather.code}, desc="${weather.description}", temp=${weather.temp}C`);

    const { multiplier, reason, condition } = getWeatherMultiplier(weather.code);
    console.log(`Mapped to: multiplier=${multiplier}x, reason=${reason}, condition=${condition}`);

    // Get all active zones to apply weather surge
    const { data: zones } = await supabase
      .from('zones')
      .select('id, name')
      .eq('is_active', true);

    const activeZones = zones ?? [];

    if (multiplier > 1.0) {
      // Bad weather — create/update weather surge entries
      const surgeExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min from now

      // Check for existing weather surge entries
      const { data: existingSurges } = await supabase
        .from('surge_zones')
        .select('id, zone_id, multiplier, reason')
        .like('reason', 'weather_%')
        .eq('active', true);

      const existingMap = new Map((existingSurges ?? []).map((s: { id: string; zone_id: string; multiplier: number }) => [s.zone_id, s]));

      for (const zone of activeZones) {
        const existing = existingMap.get(zone.id);

        if (existing) {
          // Gradual change: max +0.3 per check to avoid price jumps
          const currentMult = existing.multiplier as number;
          const targetMult = multiplier;
          const newMult = Math.min(targetMult, currentMult + 0.3);
          const finalMult = Math.max(newMult, currentMult - 0.3); // Also limit decreases

          await supabase
            .from('surge_zones')
            .update({
              multiplier: Math.round(finalMult * 100) / 100,
              reason,
              ends_at: surgeExpiry,
            })
            .eq('id', existing.id);

          console.log(`Updated weather surge for ${zone.name}: ${currentMult}x -> ${finalMult}x`);
        } else {
          // Create new weather surge (start at min of 1.2 and actual, for gradual ramp)
          const initialMult = Math.min(multiplier, 1.3);

          await supabase
            .from('surge_zones')
            .insert({
              zone_id: zone.id,
              multiplier: initialMult,
              reason,
              active: true,
              starts_at: new Date().toISOString(),
              ends_at: surgeExpiry,
            });

          console.log(`Created weather surge for ${zone.name}: ${initialMult}x`);
        }
      }
    } else {
      // Good weather — deactivate all weather surge entries
      const { data: activeSurges } = await supabase
        .from('surge_zones')
        .select('id')
        .like('reason', 'weather_%')
        .eq('active', true);

      if (activeSurges && activeSurges.length > 0) {
        const ids = activeSurges.map((s: { id: string }) => s.id);
        await supabase
          .from('surge_zones')
          .update({ active: false })
          .in('id', ids);

        console.log(`Deactivated ${ids.length} weather surge entries (clear weather)`);
      }
    }

    // Save last check status to platform_config
    const checkStatus = JSON.stringify({
      condition,
      description: weather.description,
      temp: weather.temp,
      code: weather.code,
      multiplier,
      checked_at: new Date().toISOString(),
    });

    await supabase
      .from('platform_config')
      .upsert({ key: 'weather_last_check', value: checkStatus, updated_at: new Date().toISOString() });

    return new Response(
      JSON.stringify({
        ok: true,
        weather: {
          code: weather.code,
          description: weather.description,
          temp: weather.temp,
          condition,
          multiplier,
        },
        zones_affected: multiplier > 1.0 ? activeZones.length : 0,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('sync-weather error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
