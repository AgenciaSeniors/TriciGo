// ============================================================
// TriciGo — Delivery Utilities
// Shared helpers for delivery/mensajería feature.
// ============================================================

import type { VehicleType, ServiceTypeSlug, PackageCategory } from '@tricigo/types';

// ── Map vehicle type to its default service type slug ──
// Mensajería offers all four vehicle types: moto / triciclo / auto / confort.
// 'confort' maps to the auto_confort service slug, so a confort delivery is
// priced at confort rates. Driver matching reuses the auto% pool
// (find_best_drivers: p_service_type LIKE 'auto%' → [auto, confort]), so a
// confort delivery dispatches to auto- or confort-type drivers that accept cargo.
const VEHICLE_TO_SLUG: Record<VehicleType, ServiceTypeSlug> = {
  moto: 'moto_standard',
  triciclo: 'triciclo_basico',
  auto: 'auto_standard',
  confort: 'auto_confort',
};

export function deliveryVehicleToSlug(type: VehicleType): ServiceTypeSlug {
  return VEHICLE_TO_SLUG[type];
}

// ── Is this ride carrying a package? ──
// `ride_mode` is the authority: a delivery is stored with the chosen VEHICLE's
// slug (moto_standard / triciclo_basico / auto_standard / auto_confort) plus
// ride_mode='cargo'. Checking service_type alone silently never matches — that
// is what made the driver's cargo badge invisible while the delivery card right
// above it rendered fine.
//
// 'triciclo_cargo' is kept as a second signal: it is a real service slug in the
// enum (a cargo-only tricycle), distinct from a mensajería order.
//
// Shared so the offer card and the active-trip view cannot drift apart again.
export function isCargoRide(
  ride: { ride_mode?: string | null; service_type?: string | null } | null | undefined,
): boolean {
  if (!ride) return false;
  return ride.ride_mode === 'cargo' || ride.service_type === 'triciclo_cargo';
}

// ── Package specs for compatibility checking ──
export interface PackageSpecs {
  weightKg?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  category?: PackageCategory;
}

export interface VehicleCargoCapabilities {
  type: VehicleType;
  maxWeightKg: number | null;
  maxLengthCm: number | null;
  maxWidthCm: number | null;
  maxHeightCm: number | null;
  acceptedCategories: PackageCategory[];
  availableCount: number;
}

export interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

export function isPackageCompatible(
  pkg: PackageSpecs,
  caps: VehicleCargoCapabilities,
): CompatibilityResult {
  // No available drivers with cargo enabled
  if (caps.availableCount === 0) {
    return { compatible: false, reason: 'no_vehicles_available' };
  }

  // Check weight
  if (pkg.weightKg && caps.maxWeightKg && pkg.weightKg > caps.maxWeightKg) {
    return { compatible: false, reason: 'exceeds_weight' };
  }

  // Check dimensions
  if (pkg.lengthCm && caps.maxLengthCm && pkg.lengthCm > caps.maxLengthCm) {
    return { compatible: false, reason: 'exceeds_length' };
  }
  if (pkg.widthCm && caps.maxWidthCm && pkg.widthCm > caps.maxWidthCm) {
    return { compatible: false, reason: 'exceeds_width' };
  }
  if (pkg.heightCm && caps.maxHeightCm && pkg.heightCm > caps.maxHeightCm) {
    return { compatible: false, reason: 'exceeds_height' };
  }

  // Check category
  if (pkg.category && caps.acceptedCategories.length > 0 && !caps.acceptedCategories.includes(pkg.category)) {
    return { compatible: false, reason: 'category_not_accepted' };
  }

  return { compatible: true };
}

// ── Category labels for i18n ──
export const PACKAGE_CATEGORY_LABELS: Record<PackageCategory, { es: string; en: string; pt: string }> = {
  documentos: { es: 'Documentos', en: 'Documents', pt: 'Documentos' },
  comida: { es: 'Comida', en: 'Food', pt: 'Comida' },
  paquete_pequeno: { es: 'Paquete pequeño', en: 'Small package', pt: 'Pacote pequeno' },
  paquete_grande: { es: 'Paquete grande', en: 'Large package', pt: 'Pacote grande' },
  fragil: { es: 'Frágil', en: 'Fragile', pt: 'Frágil' },
};

// ── Incompatibility reason labels ──
export const INCOMPATIBILITY_REASON_LABELS: Record<string, { es: string; en: string; pt: string }> = {
  no_vehicles_available: { es: 'Sin vehículos disponibles', en: 'No vehicles available', pt: 'Sem veículos disponíveis' },
  exceeds_weight: { es: 'Excede peso máximo', en: 'Exceeds max weight', pt: 'Excede peso máximo' },
  exceeds_length: { es: 'Excede largo máximo', en: 'Exceeds max length', pt: 'Excede comprimento máximo' },
  exceeds_width: { es: 'Excede ancho máximo', en: 'Exceeds max width', pt: 'Excede largura máxima' },
  exceeds_height: { es: 'Excede alto máximo', en: 'Exceeds max height', pt: 'Excede altura máxima' },
  category_not_accepted: { es: 'Categoría no aceptada', en: 'Category not accepted', pt: 'Categoria não aceita' },
};
