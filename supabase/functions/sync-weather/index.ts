// BUG-160 + BUG-201 + BUG-199: apikey === env.SUPABASE_SERVICE_ROLE_KEY
// (now sb_secret_*, post legacy revocation). Leaked legacy JWT
// would not match this string-equality check.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
}

const HAVANA_LAT = 23.13;
const HAVANA_LNG = -82.38;

function getWeatherMultiplier(c: number) {
  if (c >= 200 && c <= 232) return { multiplier: 1.6, reason: 'weather_storm', condition: 'storm' };
  if (c >= 300 && c <= 302) return { multiplier: 1.2, reason: 'weather_drizzle', condition: 'drizzle' };
  if (c >= 310 && c <= 321) return { multiplier: 1.3, reason: 'weather_rain', condition: 'rain' };
  if (c >= 500 && c <= 501) return { multiplier: 1.3, reason: 'weather_rain', condition: 'rain' };
  if (c >= 502 && c <= 504) return { multiplier: 1.5, reason: 'weather_heavy_rain', condition: 'heavy_rain' };
  if (c === 511) return { multiplier: 1.8, reason: 'weather_extreme', condition: 'extreme' };
  if (c >= 520 && c <= 531) return { multiplier: 1.4, reason: 'weather_rain', condition: 'rain' };
  if (c === 771 || c === 781) return { multiplier: 1.8, reason: 'weather_extreme', condition: 'extreme' };
  return { multiplier: 1.0, reason: 'weather_clear', condition: 'clear' };
}

async function fetchOpenWeatherMap(apiKey: string) {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${HAVANA_LAT}&lon=${HAVANA_LNG}&appid=${apiKey}&units=metric`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.weather && data.weather.length > 0) return { code: data.weather[0].id, description: data.weather[0].description, temp: data.main?.temp ?? 0 };
    return null;
  } catch { return null; }
}

async function fetchWttrIn() {
  try {
    const res = await fetch('https://wttr.in/Havana?format=j1', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'TriciGo/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) return null;
    const wwoCode = parseInt(current.weatherCode, 10);
    return { code: mapWwoToOwm(wwoCode), description: current.weatherDesc?.[0]?.value ?? 'Unknown', temp: parseFloat(current.temp_C) || 0 };
  } catch { return null; }
}

function mapWwoToOwm(w: number): number {
  if (w === 113) return 800;
  if (w === 116) return 802;
  if (w === 119 || w === 122) return 804;
  if (w === 143 || w === 248 || w === 260) return 741;
  if ([176,263,266,293,296].includes(w)) return 500;
  if ([299,302].includes(w)) return 501;
  if ([305,308,356,359].includes(w)) return 502;
  if ([200,386,389,392,395].includes(w)) return 211;
  return 800;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // BUG-199: apikey string-equality vs env var (which is sb_secret_*).
  // Leaked legacy JWT cannot match.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const presented = req.headers.get('apikey') ?? '';
  if (!serviceRoleKey || presented !== serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Forbidden: sync-weather is internal-only' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);
    const { data: configs } = await supabase.from('platform_config').select('key, value').in('key', ['openweather_api_key', 'weather_surge_enabled']);
    const configMap = new Map((configs ?? []).map((c: { key: string; value: string }) => [c.key, c.value]));

    const enabled = configMap.get('weather_surge_enabled');
    if (enabled === 'false' || enabled === '"false"') {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'disabled' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let weather: { code: number; description: string; temp: number } | null = null;
    const apiKey = (configMap.get('openweather_api_key') ?? '').replace(/"/g, '');
    if (apiKey && apiKey !== 'YOUR_API_KEY') weather = await fetchOpenWeatherMap(apiKey);
    if (!weather) weather = await fetchWttrIn();
    if (!weather) return new Response(JSON.stringify({ ok: false, error: 'All weather sources failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { multiplier, reason, condition } = getWeatherMultiplier(weather.code);
    const { data: zones } = await supabase.from('zones').select('id, name').eq('is_active', true);
    const activeZones = zones ?? [];

    if (multiplier > 1.0) {
      const surgeExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { data: existingSurges } = await supabase.from('surge_zones').select('id, zone_id, multiplier, reason').like('reason', 'weather_%').eq('active', true);
      const existingMap = new Map((existingSurges ?? []).map((s: { id: string; zone_id: string; multiplier: number }) => [s.zone_id, s]));

      for (const zone of activeZones) {
        const existing = existingMap.get(zone.id);
        if (existing) {
          const currentMult = existing.multiplier as number;
          const newMult = Math.min(multiplier, currentMult + 0.3);
          const finalMult = Math.max(newMult, currentMult - 0.3);
          await supabase.from('surge_zones').update({ multiplier: Math.round(finalMult * 100) / 100, reason, ends_at: surgeExpiry }).eq('id', existing.id);
        } else {
          const initialMult = Math.min(multiplier, 1.3);
          await supabase.from('surge_zones').insert({ zone_id: zone.id, multiplier: initialMult, reason, active: true, starts_at: new Date().toISOString(), ends_at: surgeExpiry });
        }
      }
    } else {
      const { data: activeSurges } = await supabase.from('surge_zones').select('id').like('reason', 'weather_%').eq('active', true);
      if (activeSurges && activeSurges.length > 0) {
        const ids = activeSurges.map((s: { id: string }) => s.id);
        await supabase.from('surge_zones').update({ active: false }).in('id', ids);
      }
    }

    const checkStatus = JSON.stringify({ condition, description: weather.description, temp: weather.temp, code: weather.code, multiplier, checked_at: new Date().toISOString() });
    await supabase.from('platform_config').upsert({ key: 'weather_last_check', value: checkStatus, updated_at: new Date().toISOString() });

    return new Response(JSON.stringify({ ok: true, weather: { code: weather.code, description: weather.description, temp: weather.temp, condition, multiplier }, zones_affected: multiplier > 1.0 ? activeZones.length : 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
