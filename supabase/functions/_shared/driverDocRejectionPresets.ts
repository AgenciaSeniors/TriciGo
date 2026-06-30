// ============================================================
// Driver document rejection presets — EF mirror (Deno).
//
// DUPLICATE of
//   packages/api/src/services/_driverDocRejectionPresets.ts
// Keep both files in sync when adding/removing/renaming presets.
//
// Reason for duplication: Edge Functions run in Deno and cannot
// import from the workspace package `@tricigo/api`. The dataset
// is small (≤10 codes per doc type) so duplicating beats publishing
// the package to esm.sh just for this. The pattern is canonical
// in the repo — see _shared/netopia-errors.ts for the same
// EF↔package mirror.
//
// Used by notify-document-rejection to render the email body
// with the Spanish labels the admin saw and the driver expects.
// ============================================================

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

type DocumentType =
  | 'national_id'
  | 'drivers_license'
  | 'vehicle_registration'
  | 'selfie'
  | 'vehicle_photo';

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
  selfie: [...GENERAL],
};

export const DOC_TYPE_LABELS_ES: Record<DocumentType, string> = {
  national_id: 'Cédula',
  drivers_license: 'Licencia de conducción',
  vehicle_registration: 'Registro del vehículo',
  selfie: 'Selfie',
  vehicle_photo: 'Foto del vehículo',
};

export function labelForCode(code: string): string {
  for (const presets of Object.values(DOC_REJECTION_PRESETS)) {
    const hit = presets.find((p) => p.code === code);
    if (hit) return hit.label_es;
  }
  return code;
}
