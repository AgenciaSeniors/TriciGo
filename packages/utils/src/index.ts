export * from './currency';
export * from './date';
export * from './validation';
export * from './ride-config';
export * from './cuba-geo';
export * from './geo';
// Pure turn-by-turn helpers (spoken instructions + maneuver arc-length),
// extracted from the driver hook so they're unit-testable without React Native.
export * from './navigation';
export * from './fareCalculator';
export * from './farePresentation';
export * from './ledger';
export { initAnalytics, trackEvent, identifyUser, resetAnalytics } from './analytics';
export type { AnalyticsEvent } from './analytics';
export {
  generateReceiptHTML,
  deriveReceiptNo,
  type ReceiptData,
  type PassengerReceiptData,
  type DriverReceiptData,
} from './receipt-template';
export { triggerHaptic, triggerSelection } from './haptics';
export { playSound, triggerFeedback, registerSoundAssets } from './sounds';
export type { SoundEvent } from './sounds';
// Silences known-benign runtime warnings (ExpoKeepAwake / expo-av / SafeAreaView /
// push token network). Native-only; web stub is a no-op. Call once at app boot.
export { setupRuntimeLogging } from './setupRuntimeLogging';
// Shared Sentry noise filtering — used by all four apps' Sentry.init configs
// (network/connectivity noise + upstream deprecations) and kept in sync with
// the native console silencer above.
export {
  SENTRY_IGNORE_PATTERNS,
  SENTRY_DENY_URLS,
  BENIGN_CONSOLE_PATTERNS,
  BENIGN_REJECTION_PATTERNS,
  BENIGN_NETWORK_PATTERNS,
  isBenignSentryMessage,
  makeSentryBeforeSend,
} from './sentryNoise';
export type { MinimalSentryEvent, MinimalSentryHint } from './sentryNoise';
export { useDebouncePress } from './useDebouncePress';
// BUG-marker-position-lag: smooth coordinate interpolation for Uber-style
// marker animation between discrete GPS samples. Used by RideMapView
// (driver + client) to avoid the "teleport every 1s" effect when the
// underlying MarkerView re-mounts on coord change.
export {
  useAnimatedCoordinate,
  lerpCoordinate,
  useAnimatedHeading,
  lerpHeading,
  HEADING_SNAP_THRESHOLD_DEG,
} from './animateCoordinate';
export type { AnimatedCoordinate } from './animateCoordinate';
// PR G (2026-05-25) — categorised debug logger for map/POI/ride flows.
// Use mapLogger.search / .viewport / .poiTap / .cameraProfile / etc. at
// the call sites you want to surface in Metro logs.
export { mapLogger, formatBbox } from './mapLogger';
export type {
  SearchEvent,
  ViewportEvent,
  PoiTapEvent,
  PoiSubmitEvent,
  CameraProfileEvent,
  MarkerHeadingEvent,
  GpsEvent,
  RouteEvent,
  TripLifecycleEvent,
} from './mapLogger';
export { generateHistoryCSV, generateWalletCSV } from './historyExport';
export { clusterDestinations, scorePredictions } from './destinationPredictor';
export type {
  RideHistoryEntry,
  DestinationCluster,
  PredictedDestination,
  PredictionReason,
} from './destinationPredictor';
export {
  SEARCH_DEBOUNCE_MS,
  searchResultCap,
  normalizeAddressLabel,
  proximityBucket,
  scoreSearchResult,
  rankSearchResults,
  searchResultEmoji,
  shouldEnrichResult,
} from './addressSearch';
export type { ScorableResult } from './addressSearch';
export { QUICK_REPLIES, getQuickRepliesForRole } from './chatQuickReplies';
export type { QuickReply } from './chatQuickReplies';
export { getErrorMessage } from './errors';
// Home announcement (CAMPAÑAS) CTA resolution — single source of truth shared
// by the client handler and the admin editor. Prevents cta_url values that
// would 404 (e.g. the web-only '/book' route on the mobile client).
export {
  resolveAnnouncementCta,
  isValidAnnouncementCta,
  announcementCtaWebHref,
  ANNOUNCEMENT_CTA_TARGETS,
} from './announcementCta';
export type { AnnouncementCtaAction, AnnouncementCtaTarget } from './announcementCta';
export { translateNetopiaError } from './netopia-errors';
export { deliveryVehicleToSlug, isPackageCompatible, PACKAGE_CATEGORY_LABELS, INCOMPATIBILITY_REASON_LABELS } from './delivery';
export type { PackageSpecs, VehicleCargoCapabilities, CompatibilityResult } from './delivery';
export { logger, setLogContext, clearLogContext } from './logger';
// Crash-proof star-rating formatter (rating_avg can be null for new accounts).
export { formatRating } from './rating';
export { isVersionOutdated } from './version';
export { offlineQueue } from './offlineQueue';
export { fuzzyMatch, stripAccents } from './fuzzyMatch';
export { SHARE_BASE_URL, buildShareUrl } from './shareRide';
export { MAP_STYLE_LIGHT, MAP_STYLE_NAV_NIGHT, MARKER, ROUTE, GLASS, MAP_COLORS } from './mapStyles';
// BUG-295: per-vehicle-type rotation offset for misaligned marker assets.
export { VEHICLE_MARKER_ROTATION_OFFSET_DEG, vehicleMarkerRotationOffset } from './markers';
// BUG-296: POI category → visual group mapping (9 restrained groups).
export { POI_VISUAL_GROUPS, POI_OTHER_GROUP, poiVisualGroup } from './poiCategories';
export type { PoiVisualGroup } from './poiCategories';
// Pre-launch preview: synthetic moving vehicles for map QA (dev/demo only).
export { TEST_VEHICLE_TYPES, generateTestVehicles, stepTestVehicles } from './test-vehicles';
export type { TestVehicle } from './test-vehicles';
// Dynamic offline map regions: grid-cell snapping + tile budgeting + LRU
// eviction for nationwide offline coverage under Mapbox's per-device limit.
export {
  OFFLINE_GRID_DEG,
  OFFLINE_MAX_TILES,
  OFFLINE_PACK_MIN_ZOOM,
  OFFLINE_PACK_MAX_ZOOM,
  OFFLINE_RERESOLVE_M,
  gridCellKey,
  cellBounds,
  estimateTileCount,
  planEviction,
  shouldReresolve,
} from './offlineRegion';
export type { RegionBounds, OfflinePackMeta, LatLng } from './offlineRegion';

/**
 * Extract initials from a name (e.g. "Carlos Garcia" → "CG").
 * Returns up to 2 characters, uppercase.
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}
export { CUBAN_CITY_PACKS } from './mapboxOffline';
export type { SearchBoxResult, TricigoCategory } from './geo';
export type { CubanParsed } from './geo';
export { jitterLocation } from './geo';
export { searchAddressSearchBox, searchOverpassPOI, searchPoisSupabase, searchStreetsSupabase, computeSpecificity, tricigoCategoryEmoji, mapExternalCategoryToTricigo, enrichWithCrossStreets, isGenericStreetAddress, lookupIntersectionPoint, parseCubanAddress, suggestCrossStreetsSupabase } from './geo';
