// ============================================================
// TriciGo — PoiMapLayers (BUG-296)
//
// Shared POI rendering for the client maps (RideMapView's SelectingView
// and ConfirmLocationScreen). Replaces the duplicated, "feo" 30-color
// CircleLayer + emoji SymbolLayer with a Google-Maps-style categorical
// badge system:
//
//   zoom ≤13   → clusters (white fill + orange ring)
//   zoom 14    → small categorical dot
//   zoom 15-16 → colored circular badge + white Ionicons glyph
//   zoom 17+   → badge + name label below
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
import { POI_VISUAL_GROUPS, poiVisualGroup } from '@tricigo/utils';

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
function buildPoiGeoJSON(pois: ViewportPoi[]): GeoJSON.FeatureCollection {
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
          visualGroup: group.key,
          color: group.color,
          // Mapbox image id — registered below via <Images>.
          iconKey: `poi-${group.key}`,
        },
      };
    }),
  };
}

export function PoiMapLayers({ MapboxGL, pois, onPoiPress, isDark }: PoiMapLayersProps) {
  // ── Ionicons → Mapbox sprite registry ──────────────────────────────
  // getImageSource renders one glyph to a PNG. White glyph (#FFFFFF) so
  // it reads on top of the colored badge circle. 34px source covers
  // retina; iconSize scales it down per zoom.
  const [poiIcons, setPoiIcons] = useState<Record<string, ImageSourcePropType>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await Promise.all(
          POI_VISUAL_GROUPS.map(async (g) => {
            const src = await Ionicons.getImageSource(
              g.icon as keyof typeof Ionicons.glyphMap,
              34,
              '#FFFFFF',
            );
            return [`poi-${g.key}`, src] as const;
          }),
        );
        if (!cancelled) {
          // getImageSource can resolve to null on glyph-render failure —
          // keep only the successfully rendered icons. The cast is safe:
          // the vector-icons ImageSource ({uri, scale}) is a structural
          // subset of ImageSourcePropType.
          const valid = entries.filter((e) => e[1] != null) as Array<
            [string, ImageSourcePropType]
          >;
          setPoiIcons(Object.fromEntries(valid));
        }
      } catch {
        // If glyph rendering fails the badge-bg circle still draws —
        // POIs degrade to colored dots, not a crash.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── GeoJSON ─────────────────────────────────────────────────────────
  const geojson = useMemo(() => {
    if (!pois || pois.length === 0) return null;
    return buildPoiGeoJSON(pois);
  }, [pois]);

  if (!MapboxGL || !geojson) return null;

  const labelColor = isDark ? '#E6E1D8' : '#3A332E';
  const labelHalo = isDark ? 'rgba(10,14,26,0.92)' : 'rgba(255,251,245,0.96)';

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
        // BUG-296: clusters up to z13 → at z14 individual dots appear,
        // at z15+ the categorical badges take over.
        clusterMaxZoomLevel={13}
        clusterRadius={44}
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
          onPoiPress({
            id: Number(feat.properties.id),
            name: String(feat.properties.name ?? ''),
            tricigo_category: (feat.properties.tricigo_category as string) || null,
            lat: Number(coords[1]),
            lng: Number(coords[0]),
            address: (feat.properties.address as string) || null,
          });
        }}
      >
        {/* ── Clusters — white fill + orange ring (Cuban Modern) ── */}
        <MapboxGL.CircleLayer
          id="poi-clusters"
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
          id="poi-cluster-count"
          filter={['has', 'point_count']}
          style={{
            textField: ['get', 'point_count_abbreviated'],
            textSize: 11,
            textColor: '#FF4D00',
            textFont: ['Open Sans Bold', 'Arial Unicode MS Bold'],
          }}
        />

        {/* ── Tier 1: small categorical dot (z14, fades by z15) ──
            Visible for isolated POIs at z14. At z15 the badge takes
            over so we fade the dot out via opacity interpolation. */}
        <MapboxGL.CircleLayer
          id="poi-dot"
          filter={['!', ['has', 'point_count']]}
          style={{
            circleColor: ['get', 'color'],
            circleRadius: ['interpolate', ['linear'], ['zoom'], 13, 3, 14.5, 4.5],
            circleStrokeWidth: 1.4,
            circleStrokeColor: 'rgba(255,255,255,0.95)',
            circleOpacity: ['interpolate', ['linear'], ['zoom'], 13, 1, 14.6, 1, 15, 0],
            circleStrokeOpacity: ['interpolate', ['linear'], ['zoom'], 13, 1, 14.6, 1, 15, 0],
          }}
        />

        {/* ── Tier 2: colored badge background (z15+) ──
            The circle behind the white glyph. Fades in over z14.6-15. */}
        <MapboxGL.CircleLayer
          id="poi-badge-bg"
          filter={['!', ['has', 'point_count']]}
          style={{
            circleColor: ['get', 'color'],
            circleRadius: ['interpolate', ['linear'], ['zoom'], 15, 9, 17, 11],
            circleStrokeWidth: 2,
            circleStrokeColor: '#FFFFFF',
            circleOpacity: ['interpolate', ['linear'], ['zoom'], 14.6, 0, 15, 1],
            circleStrokeOpacity: ['interpolate', ['linear'], ['zoom'], 14.6, 0, 15, 1],
          }}
        />

        {/* ── Tier 2b: white Ionicons glyph centered on the badge ── */}
        <MapboxGL.SymbolLayer
          id="poi-badge-icon"
          filter={['!', ['has', 'point_count']]}
          minZoomLevel={14.5}
          style={{
            iconImage: ['get', 'iconKey'],
            iconSize: ['interpolate', ['linear'], ['zoom'], 15, 0.42, 17, 0.52],
            iconAllowOverlap: true,
            iconIgnorePlacement: true,
            iconAnchor: 'center',
            iconOpacity: ['interpolate', ['linear'], ['zoom'], 14.7, 0, 15, 1],
          }}
        />

        {/* ── Tier 3: name label below the badge (z16.5+) ── */}
        <MapboxGL.SymbolLayer
          id="poi-label"
          filter={['!', ['has', 'point_count']]}
          minZoomLevel={16.5}
          style={{
            textField: ['get', 'name'],
            textSize: ['interpolate', ['linear'], ['zoom'], 16.5, 9.5, 18, 11.5],
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
