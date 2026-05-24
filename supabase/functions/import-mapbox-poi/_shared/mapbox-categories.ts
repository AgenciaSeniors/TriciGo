// ============================================================
// mapbox-categories — Map Mapbox SearchBox `poi_category` values
// onto TriciGo's unified tricigo_category taxonomy.
//
// Mapbox uses the Carmen POI taxonomy (~250 leaf categories). We
// only need to map the ones the user is likely to search for in
// Cuba. Unknown values fall through to 'other'.
//
// Keep in sync with the tricigo_category allow-list inside
// import_search_poi RPC (migration 00308) and with the OSM/Overture
// mappers in `scripts/sync-pois/categories.json`.
// ============================================================

export const MAPBOX_TO_TRICIGO: Record<string, string> = {
  // Food & drink
  restaurant: 'restaurant',
  cuban_restaurant: 'paladar',
  paladar: 'paladar',
  fine_dining_restaurant: 'restaurant',
  fast_food_restaurant: 'restaurant',
  pizza_restaurant: 'restaurant',
  food_court: 'restaurant',
  cafe: 'cafe',
  coffee_shop: 'cafe',
  bakery: 'cafe',
  ice_cream_shop: 'cafe',
  juice_bar: 'cafe',
  dessert_shop: 'cafe',
  bar: 'bar',
  pub: 'bar',
  nightclub: 'bar',
  beer_bar: 'bar',
  wine_bar: 'bar',
  lounge: 'bar',
  // Lodging
  hotel: 'hotel',
  motel: 'hotel',
  hostel: 'hotel',
  bed_and_breakfast: 'hotel',
  casa_particular: 'hotel',
  guest_house: 'hotel',
  resort: 'hotel',
  lodging: 'hotel',
  // Health
  hospital: 'hospital',
  clinic: 'hospital',
  medical_center: 'hospital',
  doctor: 'hospital',
  dentist: 'hospital',
  pharmacy: 'pharmacy',
  drugstore: 'pharmacy',
  // Education
  school: 'school',
  university: 'school',
  college: 'school',
  kindergarten: 'school',
  library: 'school',
  // Government
  city_hall: 'gov',
  government_office: 'gov',
  post_office: 'gov',
  police_station: 'gov',
  fire_station: 'gov',
  courthouse: 'gov',
  embassy: 'embassy',
  consulate: 'embassy',
  // Culture / attractions
  museum: 'museum',
  art_gallery: 'museum',
  gallery: 'museum',
  monument: 'museum',
  landmark: 'museum',
  tourist_attraction: 'museum',
  historic_site: 'museum',
  // Outdoor
  park: 'park',
  garden: 'park',
  playground: 'park',
  plaza: 'park',
  beach: 'beach',
  // Religion
  church: 'religion',
  cathedral: 'religion',
  mosque: 'religion',
  temple: 'religion',
  synagogue: 'religion',
  place_of_worship: 'religion',
  // Transport
  bus_station: 'transport',
  train_station: 'transport',
  airport: 'transport',
  taxi_stand: 'transport',
  ferry_terminal: 'transport',
  // Financial
  bank: 'bank',
  atm: 'atm',
  // Retail
  supermarket: 'supermarket',
  grocery_store: 'supermarket',
  convenience_store: 'supermarket',
  market: 'supermarket',
  // Fuel
  gas_station: 'gas_station',
  fuel: 'gas_station',
  // Generic shop catch-all
  shopping_mall: 'shop',
  clothing_store: 'shop',
  shoe_store: 'shop',
  electronics_store: 'shop',
  hardware_store: 'shop',
  bookstore: 'shop',
};

/**
 * Resolve a Mapbox poi_category array (or single value) to a TriciGo
 * category. Returns 'other' when nothing matches.
 */
export function mapboxCategoryToTricigo(
  poiCategory: string | string[] | null | undefined,
): string {
  if (!poiCategory) return 'other';
  const candidates = Array.isArray(poiCategory) ? poiCategory : [poiCategory];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const key = raw.toLowerCase().trim();
    if (MAPBOX_TO_TRICIGO[key]) return MAPBOX_TO_TRICIGO[key];
    // Substring fallback: "cuban_restaurant" already covered explicitly,
    // but generic "restaurant" inside a longer label still matches.
    for (const known of Object.keys(MAPBOX_TO_TRICIGO)) {
      if (key.includes(known)) return MAPBOX_TO_TRICIGO[known];
    }
  }
  return 'other';
}
