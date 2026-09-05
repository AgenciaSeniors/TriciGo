import { z } from 'zod';
import { normalizeCubanPhone } from '@tricigo/utils';
import type { DisputeReason, TicketCategory } from '@tricigo/types';

/**
 * Compile-time guard for the enums below that mirror a union from
 * @tricigo/types. `getSupabaseClient()` is untyped and these tables store the
 * column as free TEXT, so a Zod enum that drifts from its union is caught by
 * nothing at all — it just rejects real user input at runtime. Pairing
 * `satisfies readonly T[]` (rejects a value that is NOT in the union) with
 * `AssertNever<Exclude<T, ...>>` (fails to compile when a union member is
 * MISSING from the list) pins both directions.
 */
type AssertNever<T extends never> = T;

// Base validators
export const uuidSchema = z.string().uuid('ID inválido');
// Accept any of the three ways a Cuban user types their number — "+53 5/6XXXXXXX",
// "53 5/6XXXXXXX" (no +) or the bare local "5/6XXXXXXX" — and canonicalize to E.164
// "+53 5/6XXXXXXX" BEFORE the strict regex runs. Cuban mobiles start with 5 (legacy)
// or 6 (new ETECSA 63/64 prefixes, since late 2023). The regex stays as a post-normalize
// guard so malformed input still fails. This makes gift recipient lookup (and every
// other consumer) tolerant to input format while keeping storage canonical.
export const cubanPhoneSchema = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeCubanPhone(v.trim()) : v),
  z.string().regex(/^\+53[56]\d{7}$/, 'Número cubano inválido (+53 5XXXXXXX o 6XXXXXXX)'),
);

// Demo mode: when EXPO_PUBLIC_DEMO_MODE=true, relax geographic bounds to global
// so the app can be tested outside Cuba (see docs/DEMO_MODE.md).
const IS_DEMO = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';
export const cubaLatSchema = IS_DEMO
  ? z.number().min(-90).max(90)
  : z.number().min(19.5).max(23.5);
export const cubaLngSchema = IS_DEMO
  ? z.number().min(-180).max(180)
  : z.number().min(-85.0).max(-74.0);

// Enums
export const serviceTypeSchema = z.enum(['triciclo_basico', 'triciclo_premium', 'triciclo_cargo', 'moto_standard', 'auto_standard', 'auto_confort', 'mensajeria']);
export const paymentMethodSchema = z.enum(['cash', 'tricicoin', 'mixed', 'corporate']);

// Ride schemas
export const createRideSchema = z.object({
  service_type: serviceTypeSchema,
  payment_method: paymentMethodSchema,
  pickup_latitude: cubaLatSchema,
  pickup_longitude: cubaLngSchema,
  pickup_address: z.string().min(1).max(500),
  dropoff_latitude: cubaLatSchema,
  dropoff_longitude: cubaLngSchema,
  dropoff_address: z.string().min(1).max(500),
  // 00578: optional rider notes for the driver, one per endpoint. Cap
  // mirrors the column CHECK; trimNotes() in createRide normalises them.
  pickup_notes: z.string().trim().max(200).optional().nullable(),
  dropoff_notes: z.string().trim().max(200).optional().nullable(),
  estimated_fare_cup: z.number().positive().max(1000000).optional(),
  estimated_distance_m: z.number().positive().optional(),
  estimated_duration_s: z.number().positive().optional(),
  // Breakdown del estimate snapshot — opcional. Si se proveen, createRide
  // persiste un `ride_pricing_snapshots` row con `snapshot_type='estimate'`
  // que `complete_ride_and_pay` lee al cobrar (parity estimate↔final).
  base_fare_cup: z.number().nonnegative().max(1000000).optional(),
  per_km_rate_cup: z.number().nonnegative().max(100000).optional(),
  per_minute_rate_cup: z.number().nonnegative().max(100000).optional(),
  // Min fare snapshoteado en el estimate (B6 follow-up). El RPC lo
  // usa como floor del cálculo final cuando el snapshot está presente,
  // sino cae al `service_type_configs.min_fare_cup` live.
  min_fare_cup: z.number().nonnegative().max(100000).optional(),
  surge_multiplier: z.number().min(0.5).max(5).optional(),
  pricing_rule_id: z.string().optional(),
  scheduled_at: z.string().datetime().optional(),
  promo_code_id: uuidSchema.optional(),
  discount_amount_cup: z.number().nonnegative().optional(),
  waypoints: z.array(z.object({
    sort_order: z.number().int().nonnegative(),
    latitude: cubaLatSchema,
    longitude: cubaLngSchema,
    address: z.string().min(1).max(500),
  })).max(5).optional(),
  corporate_account_id: uuidSchema.optional(),
  insurance_selected: z.boolean().optional(),
  insurance_premium_cup: z.number().nonnegative().optional(),
  rider_preferences: z.record(z.unknown()).optional(),
  ride_mode: z.enum(['passenger', 'cargo']).optional(),
  // Ratio of fare to pay via wallet (TriciCoin) vs cash, for mixed payment.
  // 0 = all cash, 1 = all wallet. Defaults to 0 on rides without wallet split.
  wallet_ratio: z.number().min(0).max(1).optional(),
  // "Compartir viaje" (shared ride): the rider lets the driver fill empty
  // seats with other (off-platform) passengers. declared_passengers = how
  // many seats the rider occupies (incl. themselves). The per-free-seat
  // discount is computed server-side (trigger 00347) — not trusted here.
  share_ride: z.boolean().optional(),
  declared_passengers: z.number().int().min(1).max(8).optional(),
  delivery_details: z.object({
    package_description: z.string().min(1).max(1000),
    recipient_name: z.string().min(1).max(200),
    recipient_phone: z.string().min(4).max(30),
    estimated_weight_kg: z.number().positive().max(1000).optional().nullable(),
    special_instructions: z.string().max(1000).optional().nullable(),
    package_category: z.string().max(50).optional().nullable(),
    package_length_cm: z.number().positive().optional().nullable(),
    package_width_cm: z.number().positive().optional().nullable(),
    package_height_cm: z.number().positive().optional().nullable(),
    client_accompanies: z.boolean().optional(),
    delivery_vehicle_type: z.string().max(50).optional().nullable(),
  }).optional(),
});

// Wallet schemas
export const rechargeSchema = z.object({
  userId: uuidSchema,
  amount: z.number().positive().min(100).max(50000), // CUP limits
});

// Gift ("Regalo") — closed-loop user-to-user transfer (00343).
export const sendGiftSchema = z.object({
  fromUserId: uuidSchema,
  toUserId: uuidSchema,
  amount: z.number().int().positive().min(1).max(100000),
  note: z.string().max(500).optional(),
  // Source wallet the gift is debited from, by app context: the driver app
  // sends 'tricicoin', the client/web apps send 'customer_cash'. Optional —
  // the server falls back to the role-based wallet when omitted.
  fromWallet: z.enum(['customer_cash', 'tricicoin']).optional(),
}).refine(d => d.fromUserId !== d.toUserId, 'No puedes regalar a ti mismo');

// Shareable gift/QR code = referral_codes.code (00319): [A-Z0-9]{6,16}.
// Case-insensitive at the edge; the RPC upper()-normalizes.
export const giftCodeSchema = z.string().trim().regex(/^[A-Za-z0-9]{6,16}$/, 'Código inválido');

// Review schema
export const submitReviewSchema = z.object({
  ride_id: uuidSchema,
  reviewer_id: uuidSchema,
  reviewee_id: uuidSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
}).refine(d => d.reviewer_id !== d.reviewee_id, 'No puedes calificarte a ti mismo');

// Dispute schema
//
// These MUST stay in lockstep with the `DisputeReason` union in
// @tricigo/types: `disputeService.createDispute` declares its `reason`
// parameter as `DisputeReason` but validates it with this schema at runtime,
// and every reason picker (client, web) is built from that same union. The
// enum here used to be an older taxonomy — ['payment','safety','quality',
// 'route','pricing','other'] — whose only overlap with DisputeReason was
// 'other', so 9 of the 10 reasons a user could pick were rejected by
// `validate()` before the insert ever ran. `ride_disputes.reason` is free TEXT
// (no CHECK constraint), so nothing downstream caught the mismatch.
//
// See AssertNever at the top of this file for how the two-way guard works.
const DISPUTE_REASONS = [
  'wrong_fare',
  'wrong_route',
  'driver_behavior',
  'vehicle_condition',
  'safety_issue',
  'unauthorized_charge',
  'service_not_rendered',
  'excessive_wait',
  'lost_item',
  'other',
] as const satisfies readonly DisputeReason[];

type _DisputeReasonParity = AssertNever<
  Exclude<DisputeReason, (typeof DISPUTE_REASONS)[number]>
>;

export const createDisputeSchema = z.object({
  ride_id: uuidSchema,
  opened_by: uuidSchema,
  reason: z.enum(DISPUTE_REASONS),
  description: z.string().min(10).max(2000),
  evidence_urls: z.array(z.string().url()).max(5).optional(),
});

// Chat message schema
export const sendMessageSchema = z.object({
  rideId: uuidSchema,
  senderId: uuidSchema,
  body: z.string().min(1).max(5000).regex(/^[^\x00-\x08\x0B\x0C\x0E-\x1F]*$/, 'Caracteres no permitidos'),
});

// Notification schema
export const registerPushTokenSchema = z.object({
  userId: uuidSchema,
  token: z.string().min(1).max(1000),
  platform: z.enum(['ios', 'android']),
});

// Support ticket schema
//
// Same drift as the dispute reasons above: this enum used to be
// ['payment','safety','driver','technical','other'], whose only overlap with
// the `TicketCategory` union was 'other' — while the three creation UIs
// (client, driver, web help screens) and the admin label map are all built
// from TicketCategory, and `support_tickets.category` is free TEXT with no
// CHECK constraint. It never broke a user because `supportService.createTicket`
// inserts WITHOUT calling `validate()`, so the schema has no consumer today;
// wiring it up against the stale enum would have rejected every category
// except 'other'. See AssertNever at the top of this file.
const TICKET_CATEGORIES = [
  'ride_issue',
  'payment_issue',
  'driver_complaint',
  'passenger_complaint',
  'account_issue',
  'app_bug',
  'feature_request',
  'other',
] as const satisfies readonly TicketCategory[];

type _TicketCategoryParity = AssertNever<
  Exclude<TicketCategory, (typeof TICKET_CATEGORIES)[number]>
>;

export const createTicketSchema = z.object({
  user_id: uuidSchema,
  ride_id: uuidSchema.optional(),
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
});

// Location schema
export const recordLocationSchema = z.object({
  ride_id: uuidSchema,
  driver_id: uuidSchema,
  latitude: cubaLatSchema,
  longitude: cubaLngSchema,
  heading: z.number().min(0).max(360).optional(),
  speed: z.number().nonnegative().optional(),
});

// Profile update schema
export const updateProfileSchema = z.object({
  default_payment_method: paymentMethodSchema.optional(),
  saved_locations: z.array(z.object({
    // The app always sent `label`; this schema said `name` for months and
    // nobody noticed because updateProfile never ran it.
    label: z.string().min(1).max(100),
    latitude: cubaLatSchema,
    longitude: cubaLngSchema,
    address: z.string().min(1).max(500),
    kind: z.enum(['home', 'work', 'other']).optional(),
    details: z.string().trim().max(200).optional().nullable(),
  })).max(20).optional(),
  emergency_contact: z.object({
    name: z.string().min(1).max(200),
    phone: cubanPhoneSchema,
    relationship: z.string().max(50).optional(),
  }).optional(),
});

// Referral schema
export const applyReferralSchema = z.object({
  refereeId: uuidSchema,
  code: z.string().length(8).regex(/^[A-Z0-9]+$/, 'Código inválido'),
});

// Trusted contact schema
export const addContactSchema = z.object({
  user_id: uuidSchema,
  name: z.string().min(1).max(200),
  phone: cubanPhoneSchema,
  // Optional: when present, ride notifications go to email instead of SMS
  // (cost saving, mig 00497). Empty string = SMS fallback (current behavior).
  email: z.string().trim().toLowerCase().email().max(320).optional().or(z.literal('')),
  relationship: z.string().max(100).optional(),
  auto_share: z.boolean().optional(),
  is_emergency: z.boolean().optional(),
});

// Delivery schema
export const createDeliverySchema = z.object({
  ride_id: uuidSchema,
  package_description: z.string().min(1).max(1000),
  recipient_name: z.string().min(1).max(200),
  recipient_phone: cubanPhoneSchema,
  estimated_weight_kg: z.number().positive().max(1000).optional(),
  special_instructions: z.string().max(1000).optional(),
});

// Matching schema
export const findDriversSchema = z.object({
  pickup_lat: cubaLatSchema,
  pickup_lng: cubaLngSchema,
  service_type: serviceTypeSchema,
  limit: z.number().int().min(1).max(50).default(5),
  radius_m: z.number().min(500).max(15000).default(5000),
});

// Helper to validate and throw
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Validation error: ${msg}`);
  }
  return result.data;
}
