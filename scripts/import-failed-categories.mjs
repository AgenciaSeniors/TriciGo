#!/usr/bin/env node
/**
 * Re-import the 3 large categories that failed due to fetch timeouts.
 * Splits amenity/shop/tourism into smaller sub-queries to avoid timeouts.
 */

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
} catch { /* no .env */ }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lqaufszburqvlslpcuac.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Split the 3 big categories into smaller sub-queries
const QUERIES = [
  // Amenity — split by first letter ranges to reduce response size
  { label: 'amenity A-D', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["amenity"~"^[a-dA-D]"]["name"](area.cuba);way["amenity"~"^[a-dA-D]"]["name"](area.cuba););out center;`, category: 'amenity' },
  { label: 'amenity E-K', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["amenity"~"^[e-kE-K]"]["name"](area.cuba);way["amenity"~"^[e-kE-K]"]["name"](area.cuba););out center;`, category: 'amenity' },
  { label: 'amenity L-P', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["amenity"~"^[l-pL-P]"]["name"](area.cuba);way["amenity"~"^[l-pL-P]"]["name"](area.cuba););out center;`, category: 'amenity' },
  { label: 'amenity Q-Z', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["amenity"~"^[q-zQ-Z]"]["name"](area.cuba);way["amenity"~"^[q-zQ-Z]"]["name"](area.cuba););out center;`, category: 'amenity' },
  // Shop — split similarly
  { label: 'shop A-G', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["shop"~"^[a-gA-G]"]["name"](area.cuba);way["shop"~"^[a-gA-G]"]["name"](area.cuba););out center;`, category: 'shop' },
  { label: 'shop H-Z', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["shop"~"^[h-zH-Z]"]["name"](area.cuba);way["shop"~"^[h-zH-Z]"]["name"](area.cuba););out center;`, category: 'shop' },
  // Tourism — split
  { label: 'tourism A-G', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["tourism"~"^[a-gA-G]"]["name"](area.cuba);way["tourism"~"^[a-gA-G]"]["name"](area.cuba););out center;`, category: 'tourism' },
  { label: 'tourism H-Z', query: `[out:json][timeout:120];area["ISO3166-1"="CU"]->.cuba;(node["tourism"~"^[h-zH-Z]"]["name"](area.cuba);way["tourism"~"^[h-zH-Z]"]["name"](area.cuba););out center;`, category: 'tourism' },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOverpass(query, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 429) { console.log('  Rate limited, waiting 45s...'); await sleep(45_000); continue; }
      if (res.status === 504 || res.status === 503) { console.log(`  HTTP ${res.status}, waiting ${15*(attempt+1)}s...`); await sleep(15_000*(attempt+1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) { console.log(`  Retry ${attempt+1}/${retries}: ${err.message}`); await sleep(10_000*(attempt+1)); }
      else throw err;
    }
  }
}

function parseElement(elem) {
  const name = elem.tags?.name;
  if (!name) return null;
  let lat, lng;
  if (elem.type === 'way' || elem.type === 'relation') { lat = elem.center?.lat; lng = elem.center?.lon; }
  else { lat = elem.lat; lng = elem.lon; }
  if (!lat || !lng) return null;
  const addr = [elem.tags['addr:street'], elem.tags['addr:housenumber'] ? '#' + elem.tags['addr:housenumber'] : ''].filter(Boolean).join(' ') || null;
  return { osm_id: elem.id, osm_type: elem.type, name, addr, city: elem.tags['addr:city'] || null, neighborhood: elem.tags['addr:suburb'] || elem.tags['addr:neighbourhood'] || null, lat, lng, tags: elem.tags };
}

async function upsertBatch(rows) {
  const payload = rows.map(r => ({
    osm_id: r.osm_id, osm_type: r.osm_type, name: r.name,
    category: r.category, subcategory: r.subcategory,
    address: r.addr, city: r.city, neighborhood: r.neighborhood,
    location: `SRID=4326;POINT(${r.lng} ${r.lat})`, tags: r.tags,
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cuba_pois?on_conflict=osm_id,osm_type`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Supabase: ${res.status} ${text}`); }
}

async function main() {
  console.log('=== Re-importing failed categories (split) ===');
  let total = 0;

  for (const q of QUERIES) {
    try {
      console.log(`\n[${q.label}]`);
      const data = await fetchOverpass(q.query);
      const elements = data?.elements || [];
      console.log(`  Found ${elements.length} elements`);
      if (!elements.length) continue;

      const rows = elements.map(e => {
        const parsed = parseElement(e);
        if (!parsed) return null;
        const tagKey = q.category;
        const sub = e.tags[tagKey] || 'other';
        return { ...parsed, category: q.category, subcategory: sub };
      }).filter(Boolean);

      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        await upsertBatch(rows.slice(i, i + BATCH));
        if (rows.length > BATCH) console.log(`  Upserted ${Math.min(i+BATCH, rows.length)}/${rows.length}`);
      }
      console.log(`  ✓ ${rows.length} POIs`);
      total += rows.length;
      await sleep(5_000);
    } catch (err) {
      console.error(`  ✗ Failed ${q.label}: ${err.message}`);
      await sleep(10_000);
    }
  }

  console.log(`\n=== Done! Processed: ${total} ===`);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cuba_pois?select=count`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' },
    });
    console.log(`Total POIs in database: ${res.headers.get('content-range')}`);
  } catch {}
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
