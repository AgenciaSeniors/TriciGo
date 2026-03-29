// ============================================================
// TriciGo — Delivery Utilities
// Shared helpers for delivery/mensajería feature.
// ============================================================

import type { VehicleType, ServiceTypeSlug, PackageCategory } from '@tricigo/types';

// ── Map vehicle type to its default service type slug ──
const VEHICLE_TO_SLUG: Record<VehicleType, ServiceTypeSlug> = {
  moto: 'moto_standard',
  triciclo: 'triciclo_basico',
  auto: 'auto_standard',
};

export function deliveryVehicleToSlug(type: VehicleType): ServiceTypeSlug {
  return VEHICLE_TO_SLUG[type];
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
