/**
 * The vehicle a rider asked for, as support reads it: "Triciclo", "Moto", "Envío · Moto".
 * Support needs it before anything else on a waiting ride: it decides which drivers to call.
 * The slug is the fallback for a type this map does not know, never an empty label.
 */
type TFunction = (key: string, options?: { defaultValue?: string }) => string;

const TYPE_KEY: Record<string, { key: string; fallback: string }> = {
  triciclo_basico: { key: 'rides.type_triciclo', fallback: 'Triciclo' },
  triciclo_premium: { key: 'rides.type_triciclo_premium', fallback: 'Triciclo Premium' },
  moto_standard: { key: 'rides.type_moto', fallback: 'Moto' },
  auto_standard: { key: 'rides.type_auto', fallback: 'Auto' },
  auto_confort: { key: 'rides.type_auto_confort', fallback: 'Confort' },
  mensajeria: { key: 'rides.type_mensajeria', fallback: 'Mensajería' },
};

export function rideTypeLabel(t: TFunction, serviceType: string | null | undefined, rideMode?: string | null): string {
  const entry = serviceType ? TYPE_KEY[serviceType] : undefined;
  const name = entry ? t(entry.key, { defaultValue: entry.fallback }) : serviceType || '—';
  // A shipment is stored with the vehicle's slug: ride_mode is the only way to tell it apart.
  return rideMode === 'cargo' ? `${t('rides.mode_cargo', { defaultValue: 'Envío' })} · ${name}` : name;
}
