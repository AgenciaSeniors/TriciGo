export * from './currency';
export * from './date';
export * from './validation';
export * from './cuba-geo';
export * from './geo';
export * from './fareCalculator';
export * from './farePresentation';
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
export { QUICK_REPLIES, getQuickRepliesForRole } from './chatQuickReplies';
export type { QuickReply } from './chatQuickReplies';
export { getErrorMessage } from './errors';
export { translateNetopiaError } from './netopia-errors';
export { deliveryVehicleToSlug, isPackageCompatible, PACKAGE_CATEGORY_LABELS, INCOMPATIBILITY_REASON_LABELS } from './delivery';
export type { PackageSpecs, VehicleCargoCapabilities, CompatibilityResult } from './delivery';
export { logger, setLogContext, clearLogContext } from './logger';
export { offlineQueue } from './offlineQueue';
export { fuzzyMatch, stripAccents } from './fuzzyMatch';
export { SHARE_BASE_URL, buildShareUrl } from './shareRide';
export { MAP_STYLE_LIGHT, MAP_STYLE_NAV_NIGHT, MARKER, ROUTE, GLASS, MAP_COLORS } from './mapStyles';
// BUG-295: per-vehicle-type rotation offset for misaligned marker assets.
export { VEHICLE_MARKER_ROTATION_OFFSET_DEG, vehicleMarkerRotationOffset } from './markers';
// BUG-296: POI category → visual group mapping (9 restrained groups).
export { POI_VISUAL_GROUPS, POI_OTHER_GROUP, poiVisualGroup } from './poiCategories';
export type { PoiVisualGroup } from './poiCategories';

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
export type { SearchBoxResult } from './geo';
export type { CubanParsed } from './geo';
export { jitterLocation } from './geo';
export { searchAddressSearchBox, searchOverpassPOI, searchPoisSupabase, searchStreetsSupabase, computeSpecificity, tricigoCategoryEmoji, enrichWithCrossStreets, isGenericStreetAddress, lookupIntersectionPoint, parseCubanAddress, suggestCrossStreetsSupabase } from './geo';
