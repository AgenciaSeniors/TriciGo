#!/usr/bin/env node
// scripts/sync-pois/gen-sql-mapper.mjs — renders public.map_category_to_tricigo() from
// scripts/sync-pois/categories.json so the SQL mapper (what the 00581 remap and the
// cuba_pois BEFORE INSERT trigger apply) and the Python mappers in merge_and_upsert.py
// (what the weekly sync writes) can never disagree. The prod dry-run of 2026-09-05 found
// 101 active rows the two hand-written copies mapped differently — every one of them a
// category the sync would have flipped back on its next run.
//
//   node scripts/sync-pois/gen-sql-mapper.mjs > /tmp/mapper.sql
//
// The output is a full CREATE OR REPLACE FUNCTION statement. After editing categories.json,
// paste it into a NEW migration (never edit an applied one); `pnpm check:poi-taxonomy` fails
// until the newest migration that defines the function carries exactly this text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pairs = (name, entries) =>
  `  ${name} CONSTANT text[][] := ARRAY[\n${entries
    .map(([k, v]) => `    [${q(k)}, ${q(v)}]`)
    .join(',\n')}\n  ];`;

export function renderMapperSql(cats) {
  const osm = Object.entries(cats.osm).filter(([k]) => !k.startsWith('_'));
  const fsq = Object.entries(cats.foursquare.label_keywords);
  const ovt = Object.entries(cats.overture.exact);
  const ovtSub = Object.entries(cats.overture.substring);
  return `CREATE OR REPLACE FUNCTION public.map_category_to_tricigo(p_category text, p_subcategory text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
-- GENERATED from scripts/sync-pois/categories.json by scripts/sync-pois/gen-sql-mapper.mjs.
-- Do not edit by hand: edit the JSON, regenerate, paste into a NEW migration.
-- Mirror of merge_and_upsert.py: OSM \`tag=value\` exact then \`tag=*\`; a Foursquare label
-- (anything with whitespace or '>') takes the FIRST keyword found in its normalised path,
-- so the order of c_fsq is semantics; any other single category (Overture, merged rows)
-- is exact then first substring. Unknown → 'other'.
DECLARE
  v_cat  text := lower(btrim(p_category));
  v_sub  text := lower(btrim(p_subcategory));
  v_key  text;
  v_wild text;
  v_pair text[];
${pairs('c_osm', osm)}
${pairs('c_fsq', fsq)}
${pairs('c_ovt', ovt)}
${pairs('c_ovt_sub', ovtSub)}
BEGIN
  IF v_cat IS NULL OR v_cat = '' THEN RETURN 'other'; END IF;

  -- OSM tag/value (also merged rows, whose category/subcategory come from the OSM member).
  v_key  := CASE WHEN v_sub IS NOT NULL AND v_sub <> '' THEN v_cat || '=' || v_sub END;
  v_wild := NULL;
  FOREACH v_pair SLICE 1 IN ARRAY c_osm LOOP
    IF v_pair[1] = v_key THEN RETURN v_pair[2]; END IF;
    IF v_wild IS NULL AND v_pair[1] = v_cat || '=*' THEN v_wild := v_pair[2]; END IF;
  END LOOP;
  IF v_wild IS NOT NULL THEN RETURN v_wild; END IF;

  -- Foursquare category label ("Landmarks and Outdoors > Beach").
  IF v_cat ~ '[[:space:]>]' THEN
    v_key := replace(replace(v_cat, ' ', '_'), '-', '_');
    FOREACH v_pair SLICE 1 IN ARRAY c_fsq LOOP
      IF position(v_pair[1] IN v_key) > 0 THEN RETURN v_pair[2]; END IF;
    END LOOP;
    RETURN 'other';
  END IF;

  -- Overture primary category (and any other bare category).
  FOREACH v_pair SLICE 1 IN ARRAY c_ovt LOOP
    IF v_pair[1] = v_cat THEN RETURN v_pair[2]; END IF;
  END LOOP;
  FOREACH v_pair SLICE 1 IN ARRAY c_ovt_sub LOOP
    IF position(v_pair[1] IN v_cat) > 0 THEN RETURN v_pair[2]; END IF;
  END LOOP;
  RETURN 'other';
END;
$function$;`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cats = JSON.parse(readFileSync(new URL('./categories.json', import.meta.url), 'utf8'));
  process.stdout.write(renderMapperSql(cats) + '\n');
}
