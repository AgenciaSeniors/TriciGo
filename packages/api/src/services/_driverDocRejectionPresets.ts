// ============================================================
// Driver document rejection presets — single source of truth.
//
// When the admin rejects an individual driver document from
// /drivers/[id], they pick one or more chips from this list
// instead of typing the reason every time. Multi-select.
//
// The same data is mirrored verbatim in
//   supabase/functions/_shared/driverDocRejectionPresets.ts
// so the EF that sends the email can render the same Spanish
// labels without importing from packages/api (Deno cannot
// resolve the workspace). Keep them in sync. This duplication
// pattern is canonical in the repo — see
// supabase/functions/_shared/netopia-errors.ts for a similar
// EF↔package mirror.
//
// Codes are stable identifiers (never localize). Labels are
// es-CU only — the admin app is es-first and the driver app
// renders them tal cual in "Mis documentos". A future i18n pass
// would add `label_en` etc. without breaking the code.
// ============================================================

import type { DocumentType } from '@tricigo/types';

export interface DocRejectionPreset {
  code: string;
  label_es: string;
}

const GENERAL: DocRejectionPreset[] = [
  { code: 'blurry', label_es: 'Foto borrosa o ilegible' },
  { code: 'lighting', label_es: 'Mala iluminación o reflejo' },
  { code: 'cropped', label_es: 'Documento cortado en el borde' },
  { code: 'incomplete', label_es: 'Documento incompleto (faltan páginas)' },
];

export const DOC_REJECTION_PRESETS: Record<DocumentType, DocRejectionPreset[]> = {
  national_id: [
    ...GENERAL,
    { code: 'id_expired', label_es: 'Cédula vencida' },
    { code: 'id_no_number', label_es: 'No se ve el número de cédula' },
    { code: 'id_no_back', label_es: 'Falta foto del dorso' },
    { code: 'id_mismatch', label_es: 'Los datos no coinciden con el perfil' },
  ],
  drivers_license: [
    ...GENERAL,
    { code: 'lic_expired', label_es: 'Licencia vencida' },
    { code: 'lic_category', label_es: 'La categoría no permite el vehículo registrado' },
    { code: 'lic_no_back', label_es: 'Falta foto del dorso' },
  ],
  vehicle_registration: [
    ...GENERAL,
    { code: 'reg_expired', label_es: 'Registro del vehículo vencido' },
    { code: 'reg_mismatch', label_es: 'Los datos no coinciden con el vehículo del perfil' },
  ],
  vehicle_photo: [
    ...GENERAL,
    { code: 'vp_partial', label_es: 'La foto no muestra el vehículo completo' },
    { code: 'vp_unclear', label_es: 'No se ve claramente el vehículo' },
    { code: 'vp_mismatch', label_es: 'El vehículo en la foto no coincide con el registrado' },
  ],
  // CC-04 (security audit 2026-05-23) — selfie is dormant until a
  // biometric provider is wired in. Listed here for completeness so
  // a re-activation doesn't have to touch this file.
  selfie: [...GENERAL],
};

/**
 * Look up a label for a code. Searches every doc-type bucket — codes
 * are globally unique (general codes have generic names like 'blurry',
 * specific codes are prefixed like 'id_expired'/'lic_expired'). Returns
 * the code itself if no match (defensive — the UI should never send an
 * unknown code, but a future code drop shouldn't blow up the email).
 */
export function labelForCode(code: string): string {
  for (const presets of Object.values(DOC_REJECTION_PRESETS)) {
    const hit = presets.find((p) => p.code === code);
    if (hit) return hit.label_es;
  }
  return code;
}

/**
 * Compose the human-readable rejection message that lands in
 * driver_documents.rejection_reason (and renders verbatim on the
 * driver's "Mis documentos" screen). Format:
 *
 *   "Label A; Label B"                      (codes only)
 *   "Label A; Label B — free-text note"     (codes + note)
 *   "free-text note"                        (note only — degenerate, but tolerated)
 *   ""                                      (both empty — caller should never let this happen,
 *                                           the verifyDocument guard catches it)
 */
export function buildRejectionMessage(
  codes: string[] | undefined | null,
  note: string | undefined | null,
): string {
  const labels = (codes ?? []).map(labelForCode);
  const trimmedNote = note?.trim() || '';
  const joined = labels.join('; ');
  if (joined && trimmedNote) return `${joined} — ${trimmedNote}`;
  return joined || trimmedNote;
}
