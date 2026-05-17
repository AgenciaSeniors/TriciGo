// ============================================================
// TriciGo — POI category → visual group mapping (BUG-296)
//
// The map used to color POIs by `subcategory` with a 30+-entry hex map
// duplicated across RideMapView and ConfirmLocationScreen — vibrant,
// inconsistent, "feo". This module collapses every POI into one of 9
// visual groups, each with a single restrained Cuban-Modern color and
// one Ionicons glyph. Google-Maps-style: a small categorical palette,
// not a rainbow.
//
// Mapping precedence in `poiVisualGroup()`:
//   1. `tricigo_category` (unified, present for rows synced post-00248)
//   2. `subcategory` fallback (older OSM rows with null tricigo_category)
//   3. `'other'` (always — the function never returns undefined)
// ============================================================

export interface PoiVisualGroup {
  /** Stable key — used as the Mapbox image id suffix (`poi-<key>`). */
  key: string;
  /** Ionicons glyph name rendered white, centered on the colored badge. */
  icon: string;
  /** Badge / dot fill color (restrained Cuban-Modern palette). */
  color: string;
  /** Human label (Spanish) — used in the "Ir aquí" sheet / a11y. */
  label: string;
}

// 9 groups. Colors are deliberately distinct hues but warm-leaning to
// stay coherent with the Cuban-Modern aesthetic. Brand orange #FF4D00
// is reserved for the pickup pin / CTAs — `food` uses a burnt orange
// so POIs never compete with the primary action color.
export const POI_VISUAL_GROUPS: readonly PoiVisualGroup[] = [
  { key: 'food',      icon: 'restaurant',     color: '#E8590C', label: 'Comida' },
  { key: 'lodging',   icon: 'bed',            color: '#C2255C', label: 'Hospedaje' },
  { key: 'shopping',  icon: 'bag-handle',     color: '#7048E8', label: 'Compras' },
  { key: 'health',    icon: 'medkit',         color: '#0CA678', label: 'Salud' },
  { key: 'finance',   icon: 'card',           color: '#3B5BDB', label: 'Banca' },
  { key: 'civic',     icon: 'school',         color: '#6B7F8F', label: 'Servicios' },
  { key: 'culture',   icon: 'color-palette',  color: '#C2620A', label: 'Cultura' },
  { key: 'transport', icon: 'bus',            color: '#1971C2', label: 'Transporte' },
  { key: 'other',     icon: 'location',       color: '#868E96', label: 'Lugar' },
] as const;

const GROUP_BY_KEY: Record<string, PoiVisualGroup> = Object.fromEntries(
  POI_VISUAL_GROUPS.map((g) => [g.key, g]),
);

/** Fallback when nothing matches — always a valid group. */
export const POI_OTHER_GROUP: PoiVisualGroup = GROUP_BY_KEY.other!;

// tricigo_category (unified) → visual group key. These are the values
// actually present in `cuba_pois.tricigo_category` (verified in prod).
const TRICIGO_CATEGORY_TO_GROUP: Record<string, string> = {
  restaurant: 'food',
  cafe: 'food',
  bar: 'food',
  paladar: 'food',
  hotel: 'lodging',
  shop: 'shopping',
  supermarket: 'shopping',
  hospital: 'health',
  pharmacy: 'health',
  bank: 'finance',
  atm: 'finance',
  school: 'civic',
  gov: 'civic',
  embassy: 'civic',
  religion: 'civic',
  museum: 'culture',
  park: 'culture',
  beach: 'culture',
  transport: 'transport',
  gas_station: 'transport',
  other: 'other',
};

// subcategory (raw OSM) → visual group key. Fallback for older rows
// where `tricigo_category` is null. Mirrors the categories the legacy
// POI_COLORS map covered, folded into the 9 groups.
const SUBCATEGORY_TO_GROUP: Record<string, string> = {
  // food
  restaurant: 'food', cafe: 'food', bar: 'food', fast_food: 'food',
  bakery: 'food', nightclub: 'food', pub: 'food', food_court: 'food',
  // lodging
  hotel: 'lodging', guest_house: 'lodging', hostel: 'lodging',
  apartment: 'lodging', motel: 'lodging', resort: 'lodging',
  // shopping
  supermarket: 'shopping', convenience: 'shopping', marketplace: 'shopping',
  mobile_phone: 'shopping', hairdresser: 'shopping', car_repair: 'shopping',
  clothes: 'shopping', mall: 'shopping', kiosk: 'shopping',
  // health
  hospital: 'health', clinic: 'health', pharmacy: 'health',
  doctors: 'health', dentist: 'health',
  // finance
  bank: 'finance', atm: 'finance', bureau_de_change: 'finance',
  // civic
  school: 'civic', university: 'civic', college: 'civic',
  kindergarten: 'civic', post_office: 'civic', police: 'civic',
  embassy: 'civic', townhall: 'civic', fire_station: 'civic',
  place_of_worship: 'civic', library: 'civic',
  // culture
  park: 'culture', beach: 'culture', attraction: 'culture',
  museum: 'culture', monument: 'culture', theatre: 'culture',
  cinema: 'culture', artwork: 'culture', gallery: 'culture',
  // transport
  fuel: 'transport', bus_station: 'transport', ferry_terminal: 'transport',
  aerodrome: 'transport', taxi: 'transport',
};

/**
 * Resolve any POI to its visual group. Never returns undefined — an
 * unmatched POI falls through to the `'other'` group.
 *
 * @param tricigoCategory  unified category (preferred)
 * @param category         raw OSM top-level category (unused for now,
 *                         reserved for future heuristics)
 * @param subcategory      raw OSM subcategory (fallback)
 */
export function poiVisualGroup(
  tricigoCategory?: string | null,
  category?: string | null,
  subcategory?: string | null,
): PoiVisualGroup {
  if (tricigoCategory) {
    const key = TRICIGO_CATEGORY_TO_GROUP[tricigoCategory];
    if (key && GROUP_BY_KEY[key]) return GROUP_BY_KEY[key]!;
  }
  if (subcategory) {
    const key = SUBCATEGORY_TO_GROUP[subcategory];
    if (key && GROUP_BY_KEY[key]) return GROUP_BY_KEY[key]!;
  }
  // `category` is intentionally unused for now — the OSM top-level
  // category is too coarse to disambiguate (amenity/shop/tourism).
  void category;
  return POI_OTHER_GROUP;
}
