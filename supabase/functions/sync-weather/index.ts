// TriciGo — sync-weather (cron */15)
//
// WEATHER-ONLY SURGE. Zone-based and demand-based surge were removed
// (migrations 00375/00376). This function writes a single GLOBAL multiplier
// to platform_config.weather_surge_multiplier (no longer per-zone surge_zones).
// The fare estimate reads it via the get_weather_surge() RPC. Bad weather
// (rain / storm / extreme / cold front) is the only thing that can raise fares.
//
// BUG-160 + BUG-201 + BUG-199: apikey === env.SUPABASE_SERVICE_ROLE_KEY
// (now sb_secret_*, post legacy revocation). Leaked legacy JWT
// would not match this string-equality check.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
}

// Weather is sampled at Havana as a national proxy (per-province weather is a
// future enhancement). Cuba's inhabited areas never reach 0 °C, so a parsed
// temp of 0 is treated as "unknown" rather than a real cold reading.
const HAVANA_LAT = 23.13;
const HAVANA_LNG = -82.38;

// Defaults (overridable via platform_config).
const DEFAULT_COLD_THRESHOLD_C = 12; // a real "norte"/cold front for Cuba
const DEFAULT_COLD_MULTIPLIER = 1.3;
const SURGE_MAX = 3.0;

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

function parseConfigNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = parseFloat(String(raw).replace(/"/g, ''));
  return Number.isFinite(n) ? n : fallback;
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

    // Persist the single global multiplier + a human-readable status snapshot.
    const writeState = async (multiplier: number, status: Record<string, unknown>) => {
      const now = new Date().toISOString();
      await supabase.from('platform_config').upsert({ key: 'weather_surge_multiplier', value: String(multiplier), updated_at: now });
      await supabase.from('platform_config').upsert({ key: 'weather_last_check', value: JSON.stringify({ ...status, multiplier, checked_at: now }), updated_at: now });
    };

    const { data: configs } = await supabase.from('platform_config').select('key, value')
      .in('key', ['openweather_api_key', 'weather_surge_enabled', 'weather_cold_threshold_c', 'weather_cold_multiplier']);
    const configMap = new Map((configs ?? []).map((c: { key: string; value: string }) => [c.key, c.value]));

    // Kill switch → force flat fares (reset multiplier to 1.0) and exit.
    const enabled = configMap.get('weather_surge_enabled');
    if (enabled === 'false' || enabled === '"false"') {
      await writeState(1.0, { condition: 'disabled', description: 'weather surge disabled', temp: 0, code: 0, reason: 'disabled' });
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'disabled' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let weather: { code: number; description: string; temp: number } | null = null;
    const apiKey = (configMap.get('openweather_api_key') ?? '').replace(/"/g, '');
    if (apiKey && apiKey !== 'YOUR_API_KEY') weather = await fetchOpenWeatherMap(apiKey);
    if (!weather) weather = await fetchWttrIn();
    if (!weather) return new Response(JSON.stringify({ ok: false, error: 'All weather sources failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const coldThreshold = parseConfigNumber(configMap.get('weather_cold_threshold_c'), DEFAULT_COLD_THRESHOLD_C);
    const coldMultiplier = parseConfigNumber(configMap.get('weather_cold_multiplier'), DEFAULT_COLD_MULTIPLIER);

    const cond = getWeatherMultiplier(weather.code);
    let multiplier = cond.multiplier;
    let reason = cond.reason;
    let condition = cond.condition;

    // Cold front ("mucho frío"): low temperature raises surge on its own. temp
    // of 0 means the source failed to parse it, so it is ignored (never cold).
    const isCold = weather.temp > 0 && weather.temp <= coldThreshold;
    if (isCold && coldMultiplier > multiplier) {
      multiplier = coldMultiplier;
      reason = 'weather_cold';
      condition = 'cold';
    }

    multiplier = Math.min(Math.max(multiplier, 1.0), SURGE_MAX);
    multiplier = Math.round(multiplier * 100) / 100;

    await writeState(multiplier, { condition, description: weather.description, temp: weather.temp, code: weather.code, reason });

    return new Response(JSON.stringify({ ok: true, weather: { code: weather.code, description: weather.description, temp: weather.temp, condition, multiplier } }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
