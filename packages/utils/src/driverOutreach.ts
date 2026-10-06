// ============================================================
// TriciGo — reaching drivers whose signup is incomplete (00621)
//
// The admin lists drivers stuck in pending_verification
// (admin_incomplete_driver_signups) and writes to them by WhatsApp.
// This builds the wa.me link and a Spanish message that names
// exactly what each driver still has to upload.
// ============================================================

/**
 * The five documents the approval needs, in onboarding order. Kept in sync
 * with admin drivers/[id] REQUIRED_DOC_TYPES, the driver onboarding store,
 * the auto-admin EF REQUIRED_DOCS and admin_incomplete_driver_signups().
 */
export const REQUIRED_DRIVER_DOCS = [
  'national_id',
  'selfie',
  'drivers_license',
  'vehicle_registration',
  'vehicle_photo',
] as const;

// Same names as the driver app (driver.json onboarding.*).
const DOC_LABELS_ES: Record<string, string> = {
  national_id: 'Carné de identidad',
  selfie: 'Selfie de verificación',
  drivers_license: 'Licencia de conducción',
  vehicle_registration: 'Matrícula del vehículo',
  vehicle_photo: 'Foto del vehículo',
  operating_license: 'Licencia operativa',
};

/** The Spanish name the driver sees for a document type. */
export function driverDocLabel(type: string): string {
  return DOC_LABELS_ES[type] ?? type;
}

/**
 * Digits for a wa.me link: an E.164 number keeps its digits, and an 8-digit
 * Cuban mobile gets the 53 country code. Null when nothing is dialable.
 */
export function whatsAppDigits(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 8 && digits.startsWith('5')) return `53${digits}`;
  if (digits.length < 10) return null;
  return digits;
}

/** https://wa.me link that opens a chat with the text typed in, or null. */
export function waMeLink(phone: string | null | undefined, text: string): string | null {
  const digits = whatsAppDigits(phone);
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "a", "a y b", "a, b y c". */
function joinEs(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

export interface IncompleteSignupMessageInput {
  fullName: string | null | undefined;
  missingDocs: readonly string[];
  rejectedDocs: readonly string[];
}

/**
 * The WhatsApp message for a driver who started the signup and did not send
 * it. The vehicle and the application itself are only saved at the last step,
 * so every message ends with "send the application".
 */
export function incompleteSignupMessage({ fullName, missingDocs, rejectedDocs }: IncompleteSignupMessageInput): string {
  const firstName = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  const greeting = firstName ? `Hola ${firstName}, te escribimos de TriciGo.` : 'Hola, te escribimos de TriciGo.';
  const missing = missingDocs.map((d) => lowerFirst(driverDocLabel(d)));
  const rejected = rejectedDocs.map((d) => lowerFirst(driverDocLabel(d)));

  const parts: string[] = [greeting, 'Vimos que empezaste tu registro como conductor y te falta poco.'];
  if (missing.length === 0 && rejected.length === 0) {
    parts.push(
      'Ya subiste todos los documentos: solo te falta completar los datos del vehículo y enviar la solicitud desde la app TriciGo Conductor.',
    );
  } else {
    if (missing.length > 0) {
      parts.push(`Para terminarlo, entra a la app TriciGo Conductor y sube: ${joinEs(missing)}.`);
    }
    if (rejected.length > 0) {
      parts.push(
        `${missing.length > 0 ? 'También' : 'Para terminarlo,'} vuelve a subir: ${joinEs(rejected)} (no se pudo validar).`,
      );
    }
    parts.push('Después completa los datos del vehículo y envía la solicitud.');
  }
  parts.push('Si tienes alguna duda, respóndenos por aquí.');
  return parts.join(' ');
}
