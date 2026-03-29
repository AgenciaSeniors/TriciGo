import { z } from 'zod';

// Base validators
export const uuidSchema = z.string().uuid('ID inválido');
export const cubanPhoneSchema = z.string().regex(/^\+53\d{8}$/, 'Número cubano inválido (+53XXXXXXXX)');
export const cubaLatSchema = z.number().min(19.5).max(23.5);
export const cubaLngSchema = z.number().min(-85.0).max(-74.0);

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
  estimated_fare_cup: z.number().positive().max(1000000).optional(),
  estimated_distance_m: z.number().positive().optional(),
  estimated_duration_s: z.number().positive().optional(),
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

export const transferP2PSchema = z.object({
  fromUserId: uuidSchema,
  toUserId: uuidSchema,
  amount: z.number().positive().min(1).max(100000),
  note: z.string().max(500).optional(),
}).refine(d => d.fromUserId !== d.toUserId, 'No puedes transferir a ti mismo');

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
export const createDisputeSchema = z.object({
  ride_id: uuidSchema,
  opened_by: uuidSchema,
  reason: z.enum(['payment', 'safety', 'quality', 'route', 'pricing', 'other']),
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
export const createTicketSchema = z.object({
  user_id: uuidSchema,
  ride_id: uuidSchema.optional(),
  category: z.enum(['payment', 'safety', 'driver', 'technical', 'other']),
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
    name: z.string().min(1).max(100),
    latitude: cubaLatSchema,
    longitude: cubaLngSchema,
    address: z.string().min(1).max(500),
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
