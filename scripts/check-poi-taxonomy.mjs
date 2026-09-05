#!/usr/bin/env node
// scripts/check-poi-taxonomy.mjs — the tricigo_category vocabulary is declared in SIX places:
//   1. TS union / TRICIGO_CATEGORIES        packages/api/src/services/poi.service.ts
//   2. SQL poi_taxonomy()                   supabase/migrations/00579_poi_curation_foundation.sql
//   3. sync mappers                         scripts/sync-pois/categories.json
//   4. Mapbox importer map                  supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts
//   5. emoji map                            packages/utils/src/geo.ts (tricigoCategoryEmoji)
//   6. visual groups                        packages/utils/src/poiCategories.ts (TRICIGO_CATEGORY_TO_GROUP)
//   7. SQL mapper map_category_to_tricigo   newest supabase/migrations/*.sql defining it — must be
//                                           byte-for-byte what gen-sql-mapper.mjs renders from (3)
// A value that exists in one and not the others silently hides rows (00579 CHECK), drops
// imports, or renders a 📍 / grey pin; a mapper that drifts from categories.json gets its
// rows flipped back by the weekly sync. Fails the build when the sets (or the mapper) differ.
// Usage: node scripts/check-poi-taxonomy.mjs   (pnpm check:poi-taxonomy)
import { readFileSync, readdirSync } from 'node:fs';
import { renderMapperSql } from './sync-pois/gen-sql-mapper.mjs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const literals = (src) => [...src.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

// `TRICIGO_CATEGORIES: TriciGoCategory[] = [ … ]` — skip the `[]` of the type annotation.
const ts = literals(read('packages/api/src/services/poi.service.ts').match(/TRICIGO_CATEGORIES[^=]*=\s*\[([\s\S]*?)\]/)[1]);
const sql = literals(read('supabase/migrations/00579_poi_curation_foundation.sql')
  .match(/FUNCTION public\.poi_taxonomy\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]/)[1]);
const cats = JSON.parse(read('scripts/sync-pois/categories.json'));
const json = new Set([
  ...Object.entries(cats.osm).filter(([k]) => !k.startsWith('_')).map(([, v]) => v),
  ...Object.values(cats.overture.exact), ...Object.values(cats.overture.substring),
  ...Object.values(cats.foursquare.label_keywords), ...Object.values(cats.wikidata.q_ids),
]);
const mapbox = new Set(literals(read('supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts')
  .match(/MAPBOX_TO_TRICIGO[^{]*\{([\s\S]*?)\n\};/)[1].replace(/^\s*[a-z_]+:/gm, '')));
const geo = read('packages/utils/src/geo.ts');
const emoji = new Set([...geo.match(/function tricigoCategoryEmoji[\s\S]*?\n\}/)[0].matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]));
const groups = new Set([...read('packages/utils/src/poiCategories.ts')
  .match(/TRICIGO_CATEGORY_TO_GROUP[^{]*\{([\s\S]*?)\};/)[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]));
const tsUnion = new Set([...geo.match(/export type TricigoCategory =[\s\S]*?;/)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

const canon = new Set(ts);
let bad = 0;
const extra = (label, set) => {
  const out = [...set].filter((v) => !canon.has(v));
  if (out.length) { console.error(`✗ ${label} uses values outside TRICIGO_CATEGORIES: ${out.join(', ')}`); bad++; }
};
const missing = (label, set, except = []) => {
  const out = [...canon].filter((v) => !set.has(v) && !except.includes(v));
  if (out.length) { console.error(`✗ ${label} lacks taxonomy values: ${out.join(', ')}`); bad++; }
};
extra('SQL poi_taxonomy()', new Set(sql));
if (sql.length !== ts.length || sql.some((v) => !canon.has(v))) { console.error(`✗ SQL poi_taxonomy() (${sql.length}) ≠ TS TRICIGO_CATEGORIES (${ts.length})`); bad++; }
extra('scripts/sync-pois/categories.json', json);
extra('import-mapbox-poi mapbox-categories.ts', mapbox);
extra('geo.ts TricigoCategory union', tsUnion);
missing('geo.ts TricigoCategory union', tsUnion, ['other']);
missing('geo.ts tricigoCategoryEmoji()', emoji, ['other']);
missing('poiCategories.ts TRICIGO_CATEGORY_TO_GROUP', groups);

// 7. The newest migration that defines the SQL mapper must carry exactly the generated text.
const migrations = readdirSync(new URL('../supabase/migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
const mapperFile = migrations.filter((f) => read(`supabase/migrations/${f}`).includes('FUNCTION public.map_category_to_tricigo(')).pop();
const mig = read(`supabase/migrations/${mapperFile}`);
const from = mig.indexOf('CREATE OR REPLACE FUNCTION public.map_category_to_tricigo(');
const to = mig.indexOf('$function$;', from);
const embedded = from >= 0 && to >= 0 ? mig.slice(from, to + '$function$;'.length).trim() : '';
const expected = renderMapperSql(cats).trim();
if (embedded !== expected) {
  console.error(`✗ supabase/migrations/${mapperFile} map_category_to_tricigo() differs from categories.json.`);
  console.error('  Regenerate with `node scripts/sync-pois/gen-sql-mapper.mjs` and paste it into a NEW migration.');
  bad++;
}
if (bad) process.exit(1);
console.log(`✓ POI taxonomy consistent across 7 surfaces (${ts.length} values; mapper = ${mapperFile})`);
