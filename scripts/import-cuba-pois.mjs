#!/usr/bin/env node
/**
 * Import Cuba POIs from OpenStreetMap (Overpass API) into Supabase.
 * Run once to populate, re-run periodically to update.
 *
 * Usage: node scripts/import-cuba-pois.mjs
 */

// Load .env file manually (no dotenv dependency)
import { readFileSync } from 'fs';
import { resolve } from 'path';
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
} catch { /* no .env file */ }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lqaufszburqvlslpcuac.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY. Set it in .env or environment.');
  process.exit(1);
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// All POI categories to import from OSM
const CATEGORIES = [
  // Healthcare
  { key: 'amenity', value: 'hospital', category: 'amenity', sub: 'hospital' },
  { key: 'amenity', value: 'clinic', category: 'amenity', sub: 'clinic' },
  { key: 'amenity', value: 'pharmacy', category: 'amenity', sub: 'pharmacy' },
  { key: 'amenity', value: 'doctors', category: 'amenity', sub: 'doctors' },
  { key: 'amenity', value: 'dentist', category: 'amenity', sub: 'dentist' },
  // Education
  { key: 'amenity', value: 'university', category: 'amenity', sub: 'university' },
  { key: 'amenity', value: 'college', category: 'amenity', sub: 'college' },
  { key: 'amenity', value: 'school', category: 'amenity', sub: 'school' },
  // Food & Drink
  { key: 'amenity', value: 'restaurant', category: 'amenity', sub: 'restaurant' },
  { key: 'amenity', value: 'cafe', category: 'amenity', sub: 'cafe' },
  { key: 'amenity', value: 'fast_food', category: 'amenity', sub: 'fast_food' },
  { key: 'amenity', value: 'bar', category: 'amenity', sub: 'bar' },
  // Tourism
  { key: 'tourism', value: 'hotel', category: 'tourism', sub: 'hotel' },
  { key: 'tourism', value: 'guest_house', category: 'tourism', sub: 'guest_house' },
  { key: 'tourism', value: 'hostel', category: 'tourism', sub: 'hostel' },
  { key: 'tourism', value: 'motel', category: 'tourism', sub: 'motel' },
  { key: 'tourism', value: 'museum', category: 'tourism', sub: 'museum' },
  { key: 'tourism', value: 'attraction', category: 'tourism', sub: 'attraction' },
  { key: 'tourism', value: 'viewpoint', category: 'tourism', sub: 'viewpoint' },
  { key: 'tourism', value: 'information', category: 'tourism', sub: 'information' },
  // Shopping
  { key: 'shop', value: 'supermarket', category: 'shop', sub: 'supermarket' },
  { key: 'shop', value: 'convenience', category: 'shop', sub: 'convenience' },
  { key: 'shop', value: 'mall', category: 'shop', sub: 'mall' },
  { key: 'shop', value: 'bakery', category: 'shop', sub: 'bakery' },
  { key: 'shop', value: 'butcher', category: 'shop', sub: 'butcher' },
  { key: 'shop', value: 'clothes', category: 'shop', sub: 'clothes' },
  { key: 'shop', value: 'hardware', category: 'shop', sub: 'hardware' },
  // Government & Services
  { key: 'amenity', value: 'townhall', category: 'amenity', sub: 'townhall' },
  { key: 'amenity', value: 'police', category: 'amenity', sub: 'police' },
  { key: 'amenity', value: 'fire_station', category: 'amenity', sub: 'fire_station' },
  { key: 'amenity', value: 'post_office', category: 'amenity', sub: 'post_office' },
  { key: 'amenity', value: 'embassy', category: 'amenity', sub: 'embassy' },
  { key: 'amenity', value: 'courthouse', category: 'amenity', sub: 'courthouse' },
  { key: 'office', value: 'government', category: 'office', sub: 'government' },
  // Finance
  { key: 'amenity', value: 'bank', category: 'amenity', sub: 'bank' },
  { key: 'amenity', value: 'bureau_de_change', category: 'amenity', sub: 'bureau_de_change' },
  // Transport
  { key: 'amenity', value: 'bus_station', category: 'amenity', sub: 'bus_station' },
  { key: 'amenity', value: 'ferry_terminal', category: 'amenity', sub: 'ferry_terminal' },
  { key: 'amenity', value: 'fuel', category: 'amenity', sub: 'fuel' },
  { key: 'aeroway', value: 'aerodrome', category: 'aeroway', sub: 'aerodrome' },
  // Culture & Leisure
  { key: 'amenity', value: 'theatre', category: 'amenity', sub: 'theatre' },
  { key: 'amenity', value: 'cinema', category: 'amenity', sub: 'cinema' },
  { key: 'amenity', value: 'library', category: 'amenity', sub: 'library' },
  { key: 'amenity', value: 'place_of_worship', category: 'amenity', sub: 'place_of_worship' },
  { key: 'amenity', value: 'community_centre', category: 'amenity', sub: 'community_centre' },
  { key: 'leisure', value: 'park', category: 'leisure', sub: 'park' },
  { key: 'leisure', value: 'stadium', category: 'leisure', sub: 'stadium' },
  { key: 'leisure', value: 'swimming_pool', category: 'leisure', sub: 'swimming_pool' },
  { key: 'leisure', value: 'fitness_centre', category: 'leisure', sub: 'fitness_centre' },
  { key: 'leisure', value: 'sports_centre', category: 'leisure', sub: 'sports_centre' },
  // Historic
  { key: 'historic', value: 'monument', category: 'historic', sub: 'monument' },
  { key: 'historic', value: 'memorial', category: 'historic', sub: 'memorial' },
  { key: 'historic', value: 'castle', category: 'historic', sub: 'castle' },
  // Natural
  { key: 'natural', value: 'beach', category: 'natural', sub: 'beach' },
  // Accommodation extra
  { key: 'tourism', value: 'apartment', category: 'tourism', sub: 'apartment' },
  { key: 'tourism', value: 'camp_site', category: 'tourism', sub: 'camp_site' },
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOverpass(query, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429) {
        console.log('  Rate limited, waiting 30s...');
        await sleep(30_000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        console.log(`  Retry ${attempt + 1}/${retries}: ${err.message}`);
        await sleep(5_000);
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
  // Use Supabase REST API with upsert
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

async function importCategory({ key, value, category, sub }) {
  const query = `[out:json][timeout:90];area["ISO3166-1"="CU"]->.cuba;(node["${key}"="${value}"]["name"](area.cuba);way["${key}"="${value}"]["name"](area.cuba););out center;`;

  console.log(`\nImporting ${key}=${value}...`);
  const data = await fetchOverpass(query);
  const elements = data?.elements || [];
  console.log(`  Found ${elements.length} elements`);

  if (elements.length === 0) return 0;

  const rows = elements.map(e => {
    const parsed = parseElement(e);
    if (!parsed) return null;
    return { ...parsed, category, subcategory: sub };
  }).filter(Boolean);

  // Insert in batches of 500
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsertBatch(batch);
    if (i + BATCH < rows.length) console.log(`  Inserted ${i + BATCH}/${rows.length}...`);
  }

  console.log(`  ✓ Imported ${rows.length} POIs for ${sub}`);
  return rows.length;
}

// Also import named buildings, places, and other POIs not in specific categories
async function importGenericNamed() {
  // Named places (plazas, parks, neighborhoods with specific names)
  const query = `[out:json][timeout:90];area["ISO3166-1"="CU"]->.cuba;(
    node["place"~"square|locality"]["name"](area.cuba);
    way["place"~"square|locality"]["name"](area.cuba);
    node["building"]["name"](area.cuba);
    way["building"]["name"](area.cuba);
  );out center;`;

  console.log('\nImporting generic named places/buildings...');
  const data = await fetchOverpass(query);
  const elements = data?.elements || [];
  console.log(`  Found ${elements.length} elements`);

  if (elements.length === 0) return 0;

  const rows = elements.map(e => {
    const parsed = parseElement(e);
    if (!parsed) return null;
    const cat = e.tags.place ? 'place' : 'building';
    const sub = e.tags.place || e.tags.building || 'yes';
    return { ...parsed, category: cat, subcategory: sub };
  }).filter(Boolean);

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await upsertBatch(batch);
  }

  console.log(`  ✓ Imported ${rows.length} generic named POIs`);
  return rows.length;
}

async function main() {
  console.log('=== Cuba POI Import ===');
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Categories: ${CATEGORIES.length}`);

  let total = 0;

  for (const cat of CATEGORIES) {
    try {
      const count = await importCategory(cat);
      total += count;
      // Small delay between requests to be respectful to Overpass
      await sleep(2_000);
    } catch (err) {
      console.error(`  ✗ Failed ${cat.sub}: ${err.message}`);
      await sleep(5_000);
    }
  }

  // Import generic named places
  try {
    const count = await importGenericNamed();
    total += count;
  } catch (err) {
    console.error(`  ✗ Failed generic: ${err.message}`);
  }

  console.log(`\n=== Done! Total POIs imported: ${total} ===`);

  // Final count check
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
