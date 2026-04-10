export * from './currency';
export * from './date';
export * from './validation';
export * from './cuba-geo';
export * from './geo';
export * from './fareCalculator';
export { initAnalytics, trackEvent, trackValidationEvent, identifyUser, resetAnalytics } from './analytics';
export type { AnalyticsEvent } from './analytics';
export { generateReceiptHTML, type ReceiptData } from './receipt-template';
export { triggerHaptic, triggerSelection } from './haptics';
export { playSound, triggerFeedback, registerSoundAssets } from './sounds';
export type { SoundEvent } from './sounds';
export { useDebouncePress } from './useDebouncePress';
export { generateHistoryCSV } from './historyExport';
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
export { deliveryVehicleToSlug, isPackageCompatible, PACKAGE_CATEGORY_LABELS, INCOMPATIBILITY_REASON_LABELS } from './delivery';
export type { PackageSpecs, VehicleCargoCapabilities, CompatibilityResult } from './delivery';
export { logger, setLogContext, clearLogContext } from './logger';
export { offlineQueue } from './offlineQueue';
export { fuzzyMatch, stripAccents } from './fuzzyMatch';
export { SHARE_BASE_URL, buildShareUrl } from './shareRide';
export { MAP_STYLE_LIGHT, MAP_STYLE_NAV_NIGHT, MARKER, ROUTE, GLASS, MAP_COLORS } from './mapStyles';

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
export { searchAddressSearchBox, searchOverpassPOI, searchPoisSupabase, computeSpecificity, enrichWithCrossStreets, isGenericStreetAddress, lookupIntersectionPoint, parseCubanAddress, suggestCrossStreetsSupabase } from './geo';
