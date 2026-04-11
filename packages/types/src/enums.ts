// ============================================================
// TriciGo — Enumerations
// Central enum definitions for the entire domain model
// ============================================================

export type UserRole = 'customer' | 'driver' | 'admin' | 'super_admin';

export type DriverStatus =
  | 'pending_verification'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'suspended';

export type RideStatus =
  | 'searching'
  | 'accepted'
  | 'driver_en_route'
  | 'arrived_at_pickup'
  | 'in_progress'
  | 'arrived_at_destination'
  | 'completed'
  | 'canceled'
  | 'disputed';

// 'tropipay' deprecated — kept for historical DB rows only
export type PaymentMethod = 'tricicoin' | 'cash' | 'mixed' | 'stripe' | 'tropipay' | 'corporate';

export type PaymentStatus = 'not_applicable' | 'pending' | 'created' | 'paid' | 'failed';

export type VehicleType = 'triciclo' | 'moto' | 'auto';

export type ServiceTypeSlug =
  | 'triciclo_basico'
  | 'triciclo_premium'
  | 'triciclo_cargo'
  | 'moto_standard'
  | 'auto_standard'
  | 'auto_confort'
  | 'mensajeria';

export type RideMode = 'passenger' | 'cargo';

export type PackageCategory = 'documentos' | 'comida' | 'paquete_pequeno' | 'paquete_grande' | 'fragil';

export const PACKAGE_CATEGORIES: PackageCategory[] = [
  'documentos', 'comida', 'paquete_pequeno', 'paquete_grande', 'fragil',
];

export type WalletAccountType =
  | 'customer_cash'
  | 'driver_cash'
  | 'driver_hold'
  | 'driver_quota'
  | 'platform_revenue'
  | 'platform_promotions'
  | 'corporate_cash';

export type LedgerEntryType =
  | 'recharge'
  | 'ride_payment'
  | 'ride_hold'
  | 'ride_hold_release'
  | 'commission'
  | 'quota_deduction'
  | 'quota_recharge'
  | 'transfer_in'
  | 'transfer_out'
  | 'promo_credit'
  | 'redemption'
  | 'adjustment';

export type LedgerTransactionStatus =
  | 'pending'
  | 'posted'
  | 'archived'
  | 'reversed';

export type IncidentType =
  | 'sos'
  | 'safety_concern'
  | 'payment_dispute'
  | 'vehicle_issue'
  | 'driver_behavior'
  | 'passenger_behavior';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

export type IncidentStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';

export type DocumentType =
  | 'national_id'
  | 'drivers_license'
  | 'vehicle_registration'
  | 'selfie'
  | 'vehicle_photo';

export type PromotionType =
  | 'percentage_discount'
  | 'fixed_discount'
  | 'bonus_credit';

export type ReferralStatus = 'pending' | 'rewarded' | 'invalidated';

export type ZoneType = 'operational' | 'surge' | 'restricted';

export type Language = 'es' | 'en';

export type UserLevel = 'bronce' | 'plata' | 'oro';

export type PricingSnapshotType = 'estimate' | 'final';
