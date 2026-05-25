// ============================================================
// TriciGo — PoiMapLayers
//
// Shared POI rendering for ALL native maps (client + driver). Originally
// lived in apps/client (BUG-296) but was promoted to @tricigo/ui so the
// driver app can reuse the same Google-Maps-style categorical badge
// system across its RideMapView, home map, and any future map screens.
//
// Web app (apps/web) uses mapbox-gl-js with its own equivalent
// implementation in BookingMap.tsx — separate because mapbox-gl-js's
// API differs from @rnmapbox/maps'. A future PR could unify them.
//
// Display strategy:
//   zoom ≤12   → clusters (white fill + orange ring)
//   zoom 13-15 → colored circular badge + white Ionicons glyph
//   zoom 15.5+ → badge + name label below
//
// Every POI is collapsed to one of 9 visual groups (see
// packages/utils/src/poiCategories.ts) — a restrained Cuban-Modern
// palette instead of a rainbow.
//
// Icons: Ionicons glyphs rendered to PNG via `getImageSource` and
// registered as Mapbox images — GPU-rendered SymbolLayer, scales to
// hundreds of POIs without the cost of per-POI native MarkerViews.
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { ImageSourcePropType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ViewportPoi } from '@tricigo/utils';
import { POI_VISUAL_GROUPS, poiVisualGroup, mapLogger } from '@tricigo/utils';

// Inline subset of @types/geojson for the FeatureCollection shape we
// produce — keeps this file dependency-free instead of adding @types/geojson
// as a peerDep of @tricigo/ui (it's already hoisted in the workspace).
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
}

/** Tap payload emitted to the parent (opens the "Ir aquí" sheet). */
export interface PoiTapPayload {
  id: number;
  name: string;
  tricigo_category: string | null;
  lat: number;
  lng: number;
  address: string | null;
}

interface PoiMapLayersProps {
  /** The @rnmapbox/maps module — passed from the parent that already
   *  resolved it (avoids a second require / null-guard divergence). */
  MapboxGL: any;
  /** POIs from useViewportPois. */
  pois: ViewportPoi[] | null | undefined;
  /** Tap handler — when omitted, POIs render but aren't interactive
   *  (ConfirmLocationScreen passes nothing). */
  onPoiPress?: (poi: PoiTapPayload) => void;
  /** Dark mode — adjusts the label color + halo for legibility. */
  isDark?: boolean;
}

/**
 * Build the GeoJSON FeatureCollection with the per-POI visual group
 * baked into the feature properties so the Mapbox style expressions
 * (`['get', 'color']`, `['get', 'iconKey']`) resolve without any
 * runtime branching in the layer.
 */
function buildPoiGeoJSON(pois: ViewportPoi[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pois.map((p) => {
      const group = poiVisualGroup(p.tricigo_category, p.category, p.subcategory);
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
        properties: {
          id: p.id,
          name: p.name,
          tricigo_category: p.tricigo_category ?? '',
          address: p.address ?? '',
          is_admin: p.is_admin ? 1 : 0,
          // Importance tier (1=top tier Wikidata/admin, 5=lowest). Passed
          // to the SymbolLayer via `symbolSortKey` so Mapbox prioritizes
          // higher tiers when collision detection culls overlapping pins.
          // Defaults to 5 (lowest) for old rows that predate 00310.
          importance: p.importance ?? 5,
          visualGroup: group.key,
          color: group.color,
          // Mapbox image id — registered below via <Images>.
          iconKey: `poi-${group.key}`,
        },
      };
    }),
  };
}

/**
 * Render one Ionicons glyph to a Mapbox-registerable PNG source.
 * `getImageSource` occasionally resolves to null on a transient glyph-
 * render failure — retry once before giving up. Returns null only when
 * both attempts fail.
 */
async function loadGlyph(
  icon: keyof typeof Ionicons.glyphMap,
): Promise<ImageSourcePropType | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const src = await Ionicons.getImageSource(icon, 34, '#FFFFFF');
      // The vector-icons ImageSource ({uri, scale}) is a structural
      // subset of ImageSourcePropType — the cast is safe.
      if (src != null) return src as ImageSourcePropType;
    } catch {
      // swallow — fall through to the retry, then to null
    }
  }
  return null;
}

export function PoiMapLayers({ MapboxGL, pois, onPoiPress }: PoiMapLayersProps) {
  // ── Ionicons → Mapbox sprite registry ──────────────────────────────
  // getImageSource renders one glyph to a PNG. White glyph (#FFFFFF) so
  // it reads on top of the colored badge circle. 34px source covers
  // retina; iconSize scales it down per zoom.
  const [poiIcons, setPoiIcons] = useState<Record<string, ImageSourcePropType>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Fallback glyph: every group falls back to `location` when its
      // own glyph fails to render, so a POI badge is never iconless.
      const fallback = await loadGlyph('location');
      const entries = await Promise.all(
        POI_VISUAL_GROUPS.map(async (g) => {
          const src =
            (await loadGlyph(g.icon as keyof typeof Ionicons.glyphMap)) ??
            fallback;
          return [`poi-${g.key}`, src] as const;
        }),
      );
      if (cancelled) return;
      // Drop only the (rare) entries where both the group glyph AND the
      // fallback failed — those degrade to a plain colored badge.
      const icons: Record<string, ImageSourcePropType> = {};
      for (const [key, src] of entries) {
        if (src != null) icons[key] = src;
      }
      setPoiIcons(icons);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── GeoJSON ─────────────────────────────────────────────────────────
  // Always a FeatureCollection — empty when there are no POIs (e.g.
  // useViewportPois clears them below z10). Returning a stable (empty)
  // shape keeps the <ShapeSource> mounted, so Mapbox never leaves an
  // orphaned cluster layer behind on an unmount during a zoom-out.
  const geojson = useMemo<FeatureCollection>(() => {
    if (!pois || pois.length === 0) {
      return { type: 'FeatureCollection', features: [] };
    }
    return buildPoiGeoJSON(pois);
  }, [pois]);

  if (!MapboxGL) return null;

  // The map always uses MAP_STYLE_LIGHT (even when the app is in dark
  // mode), so POI name labels must always use the light-map colors.
  // Branching on isDark made labels near-white on a light map = invisible.
  const labelColor = '#3A332E';
  const labelHalo = 'rgba(255,251,245,0.96)';

  return (
    <>
      {/* Register the 9 category glyphs as Mapbox images. Empty object
          on first render is fine — the SymbolLayer simply doesn't draw
          its icon until the async getImageSource resolves (~50ms). */}
      <MapboxGL.Images images={poiIcons} />

      <MapboxGL.ShapeSource
        id="pois"
        shape={geojson}
        cluster
        // Clusters only at low zoom (≤12); from z13 the individual
        // categorical badges + icons take over (decluttered: the
        // pois_in_viewport RPC caps density per zoom).
        clusterMaxZoomLevel={12}
        clusterRadius={44}
        // 44×44pt tap area — POI badges render at only 14–22px, well
        // under the 44pt touch-target minimum. The wider hitbox lets a
        // near-miss still select the POI (the RN hitSlop equivalent).
        hitbox={{ width: 44, height: 44 }}
        onPress={(e: {
          features?: Array<{
            properties?: Record<string, unknown>;
            geometry?: { coordinates?: [number, number] };
          }>;
        }) => {
          const feat = e.features?.[0];
          if (!feat || !feat.properties || !onPoiPress) return;
          if (feat.properties.point_count) return; // cluster tap → ignore
          const coords = feat.geometry?.coordinates ?? [0, 0];
          const payload = {
            id: Number(feat.properties.id),
            name: String(feat.properties.name ?? ''),
            tricigo_category: (feat.properties.tricigo_category as string) || null,
            lat: Number(coords[1]),
            lng: Number(coords[0]),
            address: (feat.properties.address as string) || null,
          };
          // PR G — surface POI taps in Metro logs so QA can correlate
          // visual interactions with downstream consumer actions.
          mapLogger.poiTap({
            poi_id: payload.id,
            name: payload.name,
            category: payload.tricigo_category,
            lat: payload.lat,
            lng: payload.lng,
            app: 'client', // both client and driver render via this; only client wires onPoiPress today
          });
          onPoiPress(payload);
        }}
      >
        {/* ── Clusters — white fill + orange ring (Cuban Modern) ── */}
        <MapboxGL.CircleLayer
          id="tg-poi-clusters"
          filter={['has', 'point_count']}
          style={{
            circleColor: 'rgba(255,255,255,0.96)',
            circleRadius: ['step', ['get', 'point_count'], 11, 50, 14, 200, 18],
            circleStrokeWidth: ['step', ['get', 'point_count'], 1.5, 50, 2, 200, 2.5],
            circleStrokeColor: ['step', ['get', 'point_count'],
              'rgba(255,77,0,0.32)', 50,
              'rgba(255,77,0,0.55)', 200,
              'rgba(255,77,0,0.82)'],
          }}
        />
        <MapboxGL.SymbolLayer
          id="tg-poi-cluster-count"
          filter={['has', 'point_count']}
          style={{
            textField: ['get', 'point_count_abbreviated'],
            textSize: 11,
            // primary-700: 5.5:1 on the white cluster fill (the brand
            // #FF4D00 only reached 3.3:1 — fails AA for 11px text).
            textColor: '#BF3800',
            textFont: ['Open Sans Bold', 'Arial Unicode MS Bold'],
          }}
        />

        {/* ── Colored badge background — visible from z13 ──
            The circle behind the white glyph. Fades in over z12-12.6,
            then grows with zoom. */}
        <MapboxGL.CircleLayer
          id="tg-poi-badge-bg"
          filter={['!', ['has', 'point_count']]}
          style={{
            circleColor: ['get', 'color'],
            circleRadius: ['interpolate', ['linear'], ['zoom'], 13, 7, 16, 10, 17, 11],
            circleStrokeWidth: 2,
            circleStrokeColor: '#FFFFFF',
            circleOpacity: ['interpolate', ['linear'], ['zoom'], 12, 0, 12.6, 1],
            circleStrokeOpacity: ['interpolate', ['linear'], ['zoom'], 12, 0, 12.6, 1],
          }}
        />

        {/* ── White Ionicons glyph centered on the badge — from z13 ──
            Google-Maps-style collision detection:
            `iconAllowOverlap: false` + `iconIgnorePlacement: false` →
            Mapbox auto-hides overlapping pins so the map never looks
            cluttered, even when the RPC returns 1200 POIs at zoom 15
            in Centro Habana. `symbolSortKey: importance` (lower = higher
            tier) tells Mapbox to keep the tier-1 (Wikidata/admin)
            landmarks visible and cull tier-3/4/5 around them. As the
            user zooms in, more pixel space frees up and the lower
            tiers reappear automatically. */}
        <MapboxGL.SymbolLayer
          id="tg-poi-badge-icon"
          filter={['!', ['has', 'point_count']]}
          minZoomLevel={12}
          style={{
            iconImage: ['get', 'iconKey'],
            iconSize: ['interpolate', ['linear'], ['zoom'], 13, 0.32, 16, 0.46, 17, 0.5],
            iconAllowOverlap: false,
            iconIgnorePlacement: false,
            iconAnchor: 'center',
            iconOpacity: ['interpolate', ['linear'], ['zoom'], 12.2, 0, 12.8, 1],
            symbolSortKey: ['get', 'importance'],
          }}
        />

        {/* ── Name label below the badge (z15.5+) ── */}
        <MapboxGL.SymbolLayer
          id="tg-poi-label"
          filter={['!', ['has', 'point_count']]}
          minZoomLevel={15.5}
          style={{
            textField: ['get', 'name'],
            textSize: ['interpolate', ['linear'], ['zoom'], 15.5, 9.5, 18, 11.5],
            textOffset: [0, 1.7],
            textAnchor: 'top',
            textMaxWidth: 7,
            textOptional: true,
            textAllowOverlap: false,
            textColor: labelColor,
            textHaloColor: labelHalo,
            textHaloWidth: 1.4,
          }}
        />
      </MapboxGL.ShapeSource>
    </>
  );
}
