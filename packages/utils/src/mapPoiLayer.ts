/**
 * Places drawn as our own layer over the style's existing vector source.
 *
 * The base style hides most points of interest on purpose, and swapping the
 * style to reveal them would orphan every offline pack. The data is already
 * inside the tiles the app downloads, so we draw it ourselves — which also
 * means we choose what a rider actually needs to see instead of inheriting
 * a stock style's idea of a busy map.
 */

/** The style's own vector source. Both light-v11 and dark-v11 expose exactly
 *  one source under this name, mapping mapbox.mapbox-streets-v8. */
export const POI_SOURCE_ID = 'composite';
/** Mapbox Streets v8 layer holding points of interest. */
export const POI_SOURCE_LAYER = 'poi_label';
/** Ours, so taps can be queried against this layer alone. */
export const POI_LAYER_ID = 'tricigo-places';

/**
 * Categories to hide. Everything else is shown.
 *
 * This started as a whitelist of categories a rider "would want", and it
 * left the map empty: measured against a real neighbourhood, 10 of 13
 * nearby places were dropped, because the most common `maki` value in the
 * data is plain `marker` — OpenStreetMap's generic point, which no
 * hand-written list of useful-sounding words would ever include.
 *
 * A blocklist survives that mistake. It can only ever be too permissive,
 * and density is handled separately by `filterrank` below, so being wrong
 * here means a slightly busier map rather than an empty one.
 */
export const POI_MAKI_HIDDEN = [
  'toilet',
  'information',
  'picnic-site',
  'waste-basket',
  'drinking-water',
  'bench',
  'entrance',
  'roadblock',
] as const;

/** Fallback sprite image for a place whose maki isn't in the sprite.
 *  v11 sprites use bare names — `marker-15` does not exist in them. */
export const POI_FALLBACK_ICON = 'marker';

/**
 * Filter for the places layer: hide the noise, and let zoom decide density.
 *
 * `filterrank` is Mapbox's own importance score (lower is more prominent),
 * and stepping it by zoom is exactly how the stock `poi-label` layer avoids
 * burying the map in pins. Reusing their mechanism means the layer thins
 * out on a city-wide view and fills in as the rider zooms into a block,
 * with no threshold of our own to tune.
 */
export const poiFilter: unknown[] = [
  'all',
  ['match', ['get', 'maki'], [...POI_MAKI_HIDDEN], false, true],
  ['<=', ['get', 'filterrank'], ['step', ['zoom'], 1, 15, 2, 17, 3]],
];

/**
 * Sprite image name for a place.
 *
 * Bare maki name with a plain-marker fallback. An earlier version appended
 * `-15` — the convention of Mapbox's v8-era styles. The v11 sprites carry
 * 119 images and not one of them uses that suffix, so both the name and the
 * fallback resolved to nothing and the entire layer drew nothing at all,
 * with no error anywhere.
 */
export const poiIconImage: unknown[] = [
  'coalesce',
  ['image', ['get', 'maki']],
  ['image', POI_FALLBACK_ICON],
];

interface FeatureLike {
  properties?: Record<string, unknown> | null;
}

/**
 * A place's display name, preferring Spanish where the tile carries it.
 * Returns null for unnamed or blank features so callers can skip them
 * rather than showing an empty bubble.
 */
export function poiNameFromFeature(feature: FeatureLike | undefined | null): string | null {
  const props = feature?.properties;
  if (!props) return null;
  for (const key of ['name_es', 'name']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}
