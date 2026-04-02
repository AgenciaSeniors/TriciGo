#!/usr/bin/env node
/**
 * Expanded Cuba POI import — queries by tag KEY (not specific values)
 * to capture ALL named features in OSM for Cuba.
 *
 * This gets ~3-5x more POIs than the category-specific script.
 *
 * Usage: node scripts/import-cuba-pois-expanded.mjs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env
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

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Query broad tag KEYS — each gets ALL values for that key
const BROAD_QUERIES = [
  // Every amenity with a name (restaurants, banks, schools, hospitals, etc.)
  { label: 'amenity (all)', key: 'amenity', category: 'amenity' },
  // Every shop with a name
  { label: 'shop (all)', key: 'shop', category: 'shop' },
  // Every tourism feature
  { label: 'tourism (all)', key: 'tourism', category: 'tourism' },
  // Every office
  { label: 'office (all)', key: 'office', category: 'office' },
  // Every leisure facility
  { label: 'leisure (all)', key: 'leisure', category: 'leisure' },
  // Every craft workshop
  { label: 'craft (all)', key: 'craft', category: 'craft' },
  // Every healthcare facility
  { label: 'healthcare (all)', key: 'healthcare', category: 'healthcare' },
  // Historic features
  { label: 'historic (all)', key: 'historic', category: 'historic' },
  // Natural features (beaches, caves, peaks, springs)
  { label: 'natural (all)', key: 'natural', category: 'natural' },
  // Aeroway (airports, helipads)
  { label: 'aeroway (all)', key: 'aeroway', category: 'aeroway' },
  // Railway stations
  { label: 'railway stations', key: 'railway', category: 'railway' },
  // Public transport
  { label: 'public_transport (all)', key: 'public_transport', category: 'transport' },
  // Man-made features (bridges, towers, lighthouses, piers)
  { label: 'man_made (all)', key: 'man_made', category: 'man_made' },
  // Military (named bases, forts)
  { label: 'military (all)', key: 'military', category: 'military' },
  // Sport facilities
  { label: 'sport (all)', key: 'sport', category: 'sport' },
  // Emergency facilities
  { label: 'emergency (all)', key: 'emergency', category: 'emergency' },
];

// Additional queries for named places/buildings/streets
const EXTRA_QUERIES = [
  {
    label: 'named buildings',
    query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["building"]["name"](area.cuba);way["building"]["name"](area.cuba););out center;`,
    category: 'building',
  },
  {
    label: 'named places (towns, villages, suburbs, quarters)',
    query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["place"~"suburb|quarter|neighbourhood|locality|square|hamlet|village|town|city"](area.cuba);way["place"~"suburb|quarter|neighbourhood|locality|square"](area.cuba););out center;`,
    category: 'place',
  },
  {
    label: 'named landuse areas',
    query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(way["landuse"]["name"](area.cuba););out center;`,
    category: 'landuse',
  },
  {
    label: 'named highway features (bus stops, named roads)',
    query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["highway"="bus_stop"]["name"](area.cuba);node["highway"="turning_circle"]["name"](area.cuba););out center;`,
    category: 'highway',
  },
  {
    label: 'named waterways',
    query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(way["waterway"]["name"](area.cuba););out center;`,
    category: 'waterway',
  },
  {
    label: 'named boundary admin areas',
    query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(relation["boundary"="administrative"]["admin_level"~"^(6|7|8|9|10)$"]["name"](area.cuba););out center;`,
    category: 'boundary',
  },
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOverpass(query, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(180_000), // 3 min timeout for bigger queries
      });
      if (res.status === 429) {
        console.log('  Rate limited, waiting 45s...');
        await sleep(45_000);
        continue;
      }
      if (res.status === 504 || res.status === 503) {
        console.log(`  HTTP ${res.status}, retrying in ${10 * (attempt + 1)}s...`);
        await sleep(10_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        console.log(`  Retry ${attempt + 1}/${retries}: ${err.message}`);
        await sleep(8_000 * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
}

function parseElement(elem) {
  const name = elem.tags?.name;
  if (!name) return null;

  let lat, lng;
  if (elem.type === 'way' || elem.type === 'relation') {
    lat = elem.center?.lat;
    lng = elem.center?.lon;
  } else {
    lat = elem.lat;
    lng = elem.lon;
  }
  if (!lat || !lng) return null;

  const addr = [elem.tags['addr:street'], elem.tags['addr:housenumber'] ? '#' + elem.tags['addr:housenumber'] : '']
    .filter(Boolean).join(' ') || null;
  const city = elem.tags['addr:city'] || null;
  const neighborhood = elem.tags['addr:suburb'] || elem.tags['addr:neighbourhood'] || null;

  return { osm_id: elem.id, osm_type: elem.type, name, addr, city, neighborhood, lat, lng, tags: elem.tags };
}

async function upsertBatch(rows) {
  const payload = rows.map(r => ({
    osm_id: r.osm_id,
    osm_type: r.osm_type,
    name: r.name,
    category: r.category,
    subcategory: r.subcategory,
    address: r.addr,
    city: r.city,
    neighborhood: r.neighborhood,
    location: `SRID=4326;POINT(${r.lng} ${r.lat})`,
    tags: r.tags,
  }));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/cuba_pois?on_conflict=osm_id,osm_type`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed: ${res.status} ${text}`);
  }
}

async function importBroadKey({ label, key, category }) {
  // Query ALL nodes and ways that have this key AND a name, in Cuba
  const query = `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["${key}"]["name"](area.cuba);way["${key}"]["name"](area.cuba););out center;`;

  console.log(`\n[${label}]`);
  const data = await fetchOverpass(query);
  const elements = data?.elements || [];
  console.log(`  Found ${elements.length} elements`);

  if (elements.length === 0) return 0;

  const rows = elements.map(e => {
    const parsed = parseElement(e);
    if (!parsed) return null;
    // Use the specific tag value as subcategory
    const sub = e.tags[key] || 'other';
    return { ...parsed, category, subcategory: sub };
  }).filter(Boolean);

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsertBatch(batch);
    if (rows.length > BATCH) {
      console.log(`  Upserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
  }

  console.log(`  ✓ ${rows.length} POIs for ${label}`);
  return rows.length;
}

async function importExtraQuery({ label, query, category }) {
  console.log(`\n[${label}]`);
  const data = await fetchOverpass(query);
  const elements = data?.elements || [];
  console.log(`  Found ${elements.length} elements`);

  if (elements.length === 0) return 0;

  const rows = elements.map(e => {
    const parsed = parseElement(e);
    if (!parsed) return null;
    // Determine subcategory from tags
    let sub = 'other';
    for (const k of ['place', 'building', 'landuse', 'highway', 'waterway', 'boundary']) {
      if (e.tags[k]) { sub = e.tags[k]; break; }
    }
    return { ...parsed, category, subcategory: sub };
  }).filter(Boolean);

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsertBatch(batch);
    if (rows.length > BATCH) {
      console.log(`  Upserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
  }

  console.log(`  ✓ ${rows.length} POIs for ${label}`);
  return rows.length;
}

async function main() {
  console.log('=== Expanded Cuba POI Import ===');
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Broad queries: ${BROAD_QUERIES.length}`);
  console.log(`Extra queries: ${EXTRA_QUERIES.length}`);

  let total = 0;
  const failed = [];

  // 1. Broad tag-key queries
  for (const q of BROAD_QUERIES) {
    try {
      const count = await importBroadKey(q);
      total += count;
      await sleep(3_000); // Respect Overpass rate limits
    } catch (err) {
      console.error(`  ✗ Failed ${q.label}: ${err.message}`);
      failed.push(q.label);
      await sleep(10_000);
    }
  }

  // 2. Extra queries (buildings, places, streets, etc.)
  for (const q of EXTRA_QUERIES) {
    try {
      const count = await importExtraQuery(q);
      total += count;
      await sleep(3_000);
    } catch (err) {
      console.error(`  ✗ Failed ${q.label}: ${err.message}`);
      failed.push(q.label);
      await sleep(10_000);
    }
  }

  console.log(`\n=== Done! Total POIs processed: ${total} ===`);
  if (failed.length > 0) {
    console.log(`Failed queries (${failed.length}): ${failed.join(', ')}`);
  }

  // Final count
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cuba_pois?select=count`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'count=exact',
      },
    });
    const countHeader = res.headers.get('content-range');
    console.log(`Total POIs in database: ${countHeader}`);
  } catch { /* ignore */ }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
