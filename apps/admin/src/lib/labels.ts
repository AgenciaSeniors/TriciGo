/**
 * Labels the admin detail pages and marketing's read-only pages share. Each entry is an i18n key
 * and the Spanish text it falls back to; a value no map knows is shown as it is stored.
 */
import type { UserLevel } from '@tricigo/types';

type TFunction = (key: string, options?: { defaultValue?: string }) => string;

export interface LabelEntry {
  key: string;
  fallback: string;
}

// Covers every PaymentMethod value so mixed/corporate/card rides aren't mislabeled as
// "TriciCoin". stripe/tropipay are both card (legacy rows).
export const PAYMENT_LABEL: Record<string, LabelEntry> = {
  cash: { key: 'rides.payment_cash', fallback: 'Efectivo' },
  tricicoin: { key: 'rides.payment_tricicoin', fallback: 'TriciCoin' },
  mixed: { key: 'rides.payment_mixed', fallback: 'Mixto' },
  corporate: { key: 'rides.payment_corporate', fallback: 'Corporativo' },
  tropipay: { key: 'rides.payment_tropipay', fallback: 'Tarjeta' },
  stripe: { key: 'rides.payment_tropipay', fallback: 'Tarjeta' },
};

export const VEHICLE_TYPE_LABEL: Record<string, LabelEntry> = {
  triciclo: { key: 'drivers.type_triciclo', fallback: 'Triciclo' },
  moto: { key: 'drivers.type_moto', fallback: 'Moto' },
  auto: { key: 'drivers.type_auto', fallback: 'Auto' },
  confort: { key: 'drivers.type_confort', fallback: 'Confort' },
};

export const DOC_TYPE_LABEL: Record<string, LabelEntry> = {
  national_id: { key: 'drivers.doc_ci', fallback: 'Carné de identidad' },
  drivers_license: { key: 'drivers.doc_license', fallback: 'Licencia de conducción' },
  vehicle_registration: { key: 'drivers.doc_registration', fallback: 'Matrícula del vehículo' },
  selfie: { key: 'drivers.doc_selfie', fallback: 'Selfie de verificación' },
  vehicle_photo: { key: 'drivers.doc_vehicle_photo', fallback: 'Foto del vehículo' },
  operating_license: { key: 'drivers.doc_operating_license', fallback: 'Licencia operativa' },
};

export const USER_LEVEL_LABEL: Record<UserLevel, LabelEntry> = {
  bronce: { key: 'users.level_bronze', fallback: 'Bronce' },
  plata: { key: 'users.level_silver', fallback: 'Plata' },
  oro: { key: 'users.level_gold', fallback: 'Oro' },
  platino: { key: 'users.level_platinum', fallback: 'Platino' },
  diamante: { key: 'users.level_diamond', fallback: 'Diamante' },
};

/** The label of a stored value in one of the maps above, or the value itself when unknown. */
export function labelFor(t: TFunction, map: Record<string, LabelEntry>, value: string): string {
  const entry = map[value];
  return entry ? t(entry.key, { defaultValue: entry.fallback }) : value;
}
