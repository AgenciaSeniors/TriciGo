#!/usr/bin/env node
/**
 * Populate street_intersections table for ALL of Cuba.
 *
 * Strategy (v2 — Province-based):
 * 1. Query Overpass per province (15 queries instead of 1155 grid cells)
 * 2. Find intersection points (shared nodes between different named streets)
 * 3. Filter by crossing angle (>25°) to avoid parallel streets
 * 4. Insert into Supabase in batches
 *
 * Usage: node scripts/populate-cross-streets.mjs
 *
 * Estimated: ~200K-400K intersection records, ~10-20 minutes runtime
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Load .env ───
try {
  const envPath = resolve(process.cwd(), '.env');
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env */ }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lqaufszburqvlslpcuac.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY. Set it in .env or environment.');
  process.exit(1);
}

// ─── Cuba Provinces with bounding boxes ───
// Each province bbox: [south, west, north, east]
const PROVINCES = [
  { name: 'Pinar del Río',       bbox: [21.7, -84.95, 22.9, -83.25] },
  { name: 'Artemisa',            bbox: [22.3, -83.25, 23.0, -82.55] },
  { name: 'La Habana',           bbox: [22.9, -82.55, 23.25, -82.15] },
  { name: 'Mayabeque',           bbox: [22.3, -82.55, 23.0, -81.65] },
  { name: 'Matanzas',            bbox: [21.5, -82.15, 23.2, -80.65] },
  { name: 'Villa Clara',         bbox: [21.8, -80.65, 22.9, -79.45] },
  { name: 'Cienfuegos',          bbox: [21.8, -80.65, 22.35, -80.0] },
  { name: 'Sancti Spíritus',     bbox: [21.5, -80.0, 22.4, -79.0]  },
  { name: 'Ciego de Ávila',      bbox: [21.3, -79.3, 22.6, -78.4]  },
  { name: 'Camagüey',            bbox: [20.7, -78.8, 22.55, -77.4] },
  { name: 'Las Tunas',           bbox: [20.5, -77.4, 21.5, -76.4]  },
  { name: 'Holguín',             bbox: [20.3, -76.55, 21.4, -75.3] },
  { name: 'Granma',              bbox: [19.7, -77.4, 20.55, -76.2] },
  { name: 'Santiago de Cuba',    bbox: [19.8, -76.5, 20.5, -75.3]  },
  { name: 'Guantánamo',          bbox: [19.9, -75.4, 20.6, -74.1]  },
  { name: 'Isla de la Juventud', bbox: [21.4, -83.4, 22.0, -82.5]  },
];

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// ─── Helpers ───

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let lastOverpassCall = 0;
const OVERPASS_MIN_INTERVAL = 3000; // 3s between calls (be polite, only 15-30 queries total)

async function fetchOverpass(query, retries = 4) {
  // Throttle
  const now = Date.now();
  const wait = OVERPASS_MIN_INTERVAL - (now - lastOverpassCall);
  if (wait > 0) await sleep(wait);
  lastOverpassCall = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const mirror = OVERPASS_MIRRORS[attempt % OVERPASS_MIRRORS.length];
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180_000); // 3 min per province
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 429) {
        console.log('  ⏳ Rate limited, waiting 60s...');
        await sleep(60_000);
        continue;
      }
      if (res.status === 504 || res.status === 503 || res.status === 502) {
        const backoff = 20_000 * (attempt + 1);
        console.log(`  ⚠️ HTTP ${res.status}, retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(`  ⏱️ Timeout on ${mirror}, retrying...`);
      }
      if (attempt < retries) {
        const backoff = 10_000 * (attempt + 1);
        console.log(`  Retry ${attempt + 1}/${retries}: ${err.message}, waiting ${backoff / 1000}s...`);
        await sleep(backoff);
      } else {
        throw err;
      }
    }
  }
}

// Calculate bearing between two points
function bearing(lat1, lng1, lat2, lng2) {
  const cosLat = Math.cos(lat1 * Math.PI / 180);
  const dlat = (lat2 - lat1);
  const dlng = (lng2 - lng1) * cosLat;
  return Math.atan2(dlng, dlat) * 180 / Math.PI;
}

// Check if two bearings are crossing (> 25 degrees)
function isCrossing(b1, b2) {
  let diff = Math.abs(b1 - b2) % 180;
  if (diff > 90) diff = 180 - diff;
  return diff > 25;
}

// ─── Intersection Detection ───

function findIntersections(data, provinceName) {
  if (!data?.elements?.length) return [];

  // Separate ways and nodes
  const nodes = new Map();
  const ways = [];

  for (const el of data.elements) {
    if (el.type === 'node' && el.lat !== undefined) {
      nodes.set(el.id, { lat: el.lat, lon: el.lon });
    } else if (el.type === 'way' && el.tags?.name && el.nodes?.length >= 2) {
      ways.push({
        id: el.id,
        name: el.tags.name,
        nodeIds: el.nodes,
        highway: el.tags.highway || '',
      });
    }
  }

  if (ways.length === 0) return [];
  console.log(`    ${ways.length} named ways, ${nodes.size} nodes`);

  // Build node-to-ways index
  const nodeToWays = new Map();
  for (let wi = 0; wi < ways.length; wi++) {
    for (const nid of ways[wi].nodeIds) {
      if (!nodeToWays.has(nid)) nodeToWays.set(nid, []);
      nodeToWays.get(nid).push(wi);
    }
  }

  // Find intersections: nodes shared by 2+ ways with different names
  const intersections = [];
  const seen = new Set();

  for (const [nodeId, wayIndices] of nodeToWays) {
    if (wayIndices.length < 2) continue;

    const node = nodes.get(nodeId);
    if (!node) continue;

    // Group ways by name at this node
    const nameToWays = new Map();
    for (const wi of wayIndices) {
      const name = ways[wi].name;
      if (!nameToWays.has(name)) nameToWays.set(name, []);
      nameToWays.get(name).push(wi);
    }

    const uniqueNames = [...nameToWays.keys()];
    if (uniqueNames.length < 2) continue;

    // Calculate bearing for each way at this node
    const nameBearings = new Map();
    for (const [name, wis] of nameToWays) {
      const way = ways[wis[0]];
      const nIdx = way.nodeIds.indexOf(nodeId);
      if (nIdx < 0) continue;

      let adjIdx = nIdx + 1;
      if (adjIdx >= way.nodeIds.length) adjIdx = nIdx - 1;
      if (adjIdx < 0) continue;

      const adjNode = nodes.get(way.nodeIds[adjIdx]);
      if (!adjNode) continue;

      const b = bearing(node.lat, node.lon, adjNode.lat, adjNode.lon);
      nameBearings.set(name, b);
    }

    // For each pair of crossing streets, create an intersection record
    for (let i = 0; i < uniqueNames.length; i++) {
      const mainName = uniqueNames[i];
      const mainBearing = nameBearings.get(mainName);
      if (mainBearing === undefined) continue;

      const crosses = [];
      for (let j = 0; j < uniqueNames.length; j++) {
        if (i === j) continue;
        const crossBearing = nameBearings.get(uniqueNames[j]);
        if (crossBearing === undefined) continue;
        if (isCrossing(mainBearing, crossBearing)) {
          crosses.push(uniqueNames[j]);
        }
      }

      if (crosses.length === 0) continue;

      const dedupKey = `${mainName}-${nodeId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      intersections.push({
        main_street: mainName,
        cross_street_1: crosses[0] || null,
        cross_street_2: crosses[1] || null,
        lat: node.lat,
        lng: node.lon,
        province: provinceName,
        bearing: Math.round(((mainBearing % 180) + 180) % 180),
      });
    }
  }

  return intersections;
}

// ─── Nominatim for municipality (batch per province) ───

const adminCache = new Map();
let lastNominatimCall = 0;

async function getMunicipality(lat, lng) {
  // Round to 0.05° (~5.5km) for cache
  const key = `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;
  if (adminCache.has(key)) return adminCache.get(key);

  const now = Date.now();
  const wait = 1100 - (now - lastNominatimCall);
  if (wait > 0) await sleep(wait);
  lastNominatimCall = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es&zoom=14`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TriciGo/1.0 (https://tricigo.com)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const addr = data.address || {};
    const result = addr.city_district || addr.suburb || addr.city || addr.town || addr.village || '';
    adminCache.set(key, result);
    return result;
  } catch {
    adminCache.set(key, '');
    return '';
  }
}

// ─── Supabase Insert ───

async function upsertBatch(rows) {
  if (rows.length === 0) return 0;

  const payload = rows.map(r => ({
    main_street: r.main_street,
    cross_street_1: r.cross_street_1,
    cross_street_2: r.cross_street_2,
    intersection_point: `SRID=4326;POINT(${r.lng} ${r.lat})`,
    municipality: r.municipality || null,
    province: r.province || null,
    bearing: r.bearing || null,
  }));

  let inserted = 0;
  const BATCH_SIZE = 500;
  for (let i = 0; i < payload.length; i += BATCH_SIZE) {
    const batch = payload.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/street_intersections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`    ❌ Insert error: ${res.status} ${text.slice(0, 200)}`);
    } else {
      inserted += batch.length;
    }
  }
  return inserted;
}

// ─── Enrich intersections with municipality data ───

async function enrichWithMunicipality(intersections) {
  // Sample unique locations (grid of ~5km) for municipality lookup
  const gridMap = new Map(); // grid key → {lat, lng}
  for (const ix of intersections) {
    const gk = `${(Math.round(ix.lat * 20) / 20).toFixed(2)},${(Math.round(ix.lng * 20) / 20).toFixed(2)}`;
    if (!gridMap.has(gk)) gridMap.set(gk, { lat: ix.lat, lng: ix.lng });
  }

  console.log(`    Resolving municipality for ${gridMap.size} grid cells...`);
  const municipalityMap = new Map();
  let count = 0;
  for (const [gk, coord] of gridMap) {
    const muni = await getMunicipality(coord.lat, coord.lng);
    municipalityMap.set(gk, muni);
    count++;
    if (count % 20 === 0) {
      process.stdout.write(`    ${count}/${gridMap.size} municipalities resolved\r`);
    }
  }
  console.log(`    ✅ ${gridMap.size} municipalities resolved`);

  // Assign municipality to each intersection
  for (const ix of intersections) {
    const gk = `${(Math.round(ix.lat * 20) / 20).toFixed(2)},${(Math.round(ix.lng * 20) / 20).toFixed(2)}`;
    ix.municipality = municipalityMap.get(gk) || '';
  }
}

// ─── Main ───

async function main() {
  console.log('=== Populate Street Intersections — Province Strategy (v2) ===\n');
  console.log(`${PROVINCES.length} provinces to process\n`);

  let totalIntersections = 0;
  let totalInserted = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let pi = 0; pi < PROVINCES.length; pi++) {
    const prov = PROVINCES[pi];
    const [south, west, north, east] = prov.bbox;
    console.log(`\n[${pi + 1}/${PROVINCES.length}] ${prov.name} (${south},${west} → ${north},${east})`);

    try {
      // Query ALL named highways in this province
      const query = `[out:json][timeout:120][bbox:${south},${west},${north},${east}];
way["highway"]["name"];
out body;
>;
out skel qt;`;

      console.log('  📡 Querying Overpass...');
      const queryStart = Date.now();
      const data = await fetchOverpass(query);
      const queryTime = ((Date.now() - queryStart) / 1000).toFixed(1);
      console.log(`  ✅ Overpass responded in ${queryTime}s (${data?.elements?.length || 0} elements)`);

      // Find intersections
      console.log('  🔍 Finding intersections...');
      const intersections = findIntersections(data, prov.name);
      console.log(`  📍 ${intersections.length} intersections found`);

      if (intersections.length === 0) continue;

      // Enrich with municipality data
      await enrichWithMunicipality(intersections);

      // Insert into Supabase
      console.log(`  💾 Inserting into Supabase...`);
      const inserted = await upsertBatch(intersections);
      totalInserted += inserted;
      totalIntersections += intersections.length;

      console.log(`  ✅ ${prov.name}: ${intersections.length} intersections inserted (running total: ${totalIntersections})`);

    } catch (err) {
      errors++;
      console.error(`  ❌ ${prov.name} ERROR: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== Done in ${elapsed} minutes ===`);
  console.log(`Provinces processed: ${PROVINCES.length}`);
  console.log(`Total intersections: ${totalIntersections}`);
  console.log(`Total inserted: ${totalInserted}`);
  console.log(`Errors: ${errors}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
