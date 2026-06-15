export { getSupabaseClient, getSupabaseAdmin } from './client';
export * from './schemas';
export * from './errors';
export type { SupabaseClient } from './client';
export { authService, isRateLimitError } from './services/auth.service';
export type { RateLimitError } from './services/auth.service';
export { poiService, TRICIGO_CATEGORIES } from './services/poi.service';
export type { Poi, PoiInput, PoiSource, TriciGoCategory, PoiListFilters, PoiListResult } from './services/poi.service';
export { walletService } from './services/wallet.service';
export { rideService } from './services/ride.service';
export { driverService } from './services/driver.service';
export { reviewService } from './services/review.service';
export { adminService } from './services/admin.service';
export { queryKeys } from './queries/keys';
export { createStorageAdapter } from './storage';
export type { StorageAdapter } from './storage';
export { configureStorage } from './client';
export { uploadFileFromUri } from './services/_storage-upload';
export { customerService } from './services/customer.service';
export { chatService } from './services/chat.service';
export { incidentService } from './services/incident.service';
export { notificationService } from './services/notification.service';
export { deviceService } from './services/device.service';
export type { RegisterLoginDeviceInput, KnownDevice } from './services/device.service';
export { locationService } from './services/location.service';
export { matchingService } from './services/matching.service';
export { fraudService } from './services/fraud.service';
export { supportService } from './services/support.service';
export { referralService } from './services/referral.service';
export { deliveryService } from './services/delivery.service';
export type { DeliveryDetails, PublicDeliveryView, ValidateOtpResult, CreateDeliveryParams } from './services/delivery.service';
export { nearbyService } from './services/nearby.service';
export { exchangeRateService } from './services/exchange-rate.service';
export { presenceService } from './services/presence.service';
export { realtimeStatusLogger } from './services/_realtime-status';
export {
  initOfflineQueue,
  registerOfflineMutation,
  setOnlineStatus,
  getOnlineStatus,
  executeOrQueue,
  getPendingCount,
  getPendingMutations,
  getProcessingStatus,
  onQueueChange,
} from './lib/offlineQueue';
export type { QueuedMutation, ProcessingStatus } from './lib/offlineQueue';
export { registerAllOfflineMutations } from './lib/offlineMutations';
export { useFeatureFlag } from './hooks/useFeatureFlag';
export { cmsService, type CmsContent } from './services/cms.service';
export { questService } from './services/quest.service';
export { blogService, type BlogPost } from './services/blog.service';
export { announcementService, type HomeAnnouncement } from './services/announcement.service';
export { promotionService, type Promotion, type PromotionType } from './services/promotion.service';
export { paymentService } from './services/payment.service';
export { corporateService } from './services/corporate.service';
export { fleetService } from './services/fleet.service';
export { invoiceService } from './services/invoice.service';
export { trustedContactService } from './services/trusted-contact.service';
export { disputeService } from './services/dispute.service';
export { lostItemService } from './services/lost-item.service';
export { recurringRideService } from './services/recurring-ride.service';
export { cityService } from './services/city.service';
export { suggestionsService } from './services/suggestions.service';
export { trackValidationEvent } from './services/validation.service';
export { blockService } from './services/block.service';
