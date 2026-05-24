-- ============================================================
-- Migration 00306: extend cuba_pois.source CHECK to include 'wikidata'
--
-- PR 6 of the POI parity program. The Wikidata SPARQL pipeline writes
-- rows with source='wikidata' (Cuban landmarks: Capitolio, Catedral,
-- Plaza Revolución, museos, fortalezas históricas).
--
-- Same pattern as the 'crowdsource' extension we did inline with PR 3.
-- Idempotent — safe to re-apply.
-- ============================================================

ALTER TABLE public.cuba_pois
  DROP CONSTRAINT IF EXISTS cuba_pois_source_check;

ALTER TABLE public.cuba_pois
  ADD CONSTRAINT cuba_pois_source_check
  CHECK (source IN ('admin','osm','overture','foursquare','merged','crowdsource','wikidata'));
