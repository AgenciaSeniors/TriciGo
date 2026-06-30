import { create } from 'zustand';
import type { VehicleType, DocumentType, PackageCategory, ServiceTypeSlug } from '@tricigo/types';

interface PersonalInfoDraft {
  full_name: string;
  phone: string;
  email: string;
  identity_number: string;
  province: string;
  municipality: string;
  address: string;
  has_criminal_record: boolean;
  criminal_record_details: string;
}

interface VehicleDraft {
  type: VehicleType | null;
  service_type_slug?: ServiceTypeSlug;
  make: string;
  model: string;
  year: string;
  color: string;
  plate_number: string;
  capacity: string;
  accepts_cargo: boolean;
  max_cargo_weight_kg: string;
  max_cargo_length_cm: string;
  max_cargo_width_cm: string;
  max_cargo_height_cm: string;
  accepted_cargo_categories: PackageCategory[];
}

export interface DocumentDraft {
  document_type: DocumentType;
  uri: string;
  fileName: string;
  mimeType: string | null;
  uploaded: boolean;
  uploading: boolean;
  error: string | null;
  /**
   * Optional documents are shown in the UI (labeled "Opcional") but do NOT
   * gate progression: the Next/Submit buttons enable once every NON-optional
   * doc is uploaded. Mirrored by the admin approval gate
   * (apps/admin/.../drivers/[id]/page.tsx REQUIRED_DOC_TYPES) and the
   * auto-admin EF REQUIRED_DOCS — keep the three in sync.
   */
  optional?: boolean;
}

interface OnboardingState {
  personalInfo: PersonalInfoDraft;
  vehicle: VehicleDraft;
  documents: DocumentDraft[];
  driverProfileId: string | null;

  setPersonalInfo: (info: Partial<PersonalInfoDraft>) => void;
  setVehicle: (vehicle: Partial<VehicleDraft>) => void;
  setDocumentUri: (type: DocumentType, uri: string, fileName: string, mimeType?: string | null) => void;
  setDocumentUploaded: (type: DocumentType) => void;
  setDocumentUploading: (type: DocumentType, uploading: boolean) => void;
  setDocumentError: (type: DocumentType, error: string | null) => void;
  setDriverProfileId: (id: string) => void;
  reset: () => void;
}

// CC-04 (security audit 2026-05-23, PR-04 — opción C): selfie removed
// from driver onboarding until real biometric provider integrated.
// Before this change the selfie step ran a placeholder that returned
// random pass scores when SELFIE_VERIFICATION_ENABLED was not set —
// the UI promised verification it never performed. Manual admin
// review of national_id + drivers_license + vehicle_registration is
// the active KYC control. The `selfie_checks` table and `verify-selfie`
// edge function remain in the codebase so a future PR can plug in
// AWS Rekognition (or equivalent) without re-adding the step here.
// drivers_license is OPTIONAL (product decision 2026-06-30): not every Cuban
// driver has/needs one (e.g. triciclo). It's still shown so they can upload
// it, labeled "Opcional", and the admin can verify it if present — but its
// absence never blocks onboarding or approval. Required = national_id +
// vehicle_registration + vehicle_photo.
const INITIAL_DOCUMENTS: DocumentDraft[] = [
  { document_type: 'national_id', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null },
  { document_type: 'drivers_license', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null, optional: true },
  { document_type: 'vehicle_registration', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null },
  { document_type: 'vehicle_photo', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null },
];

const INITIAL_STATE = {
  personalInfo: {
    full_name: '',
    phone: '',
    email: '',
    identity_number: '',
    province: '',
    municipality: '',
    address: '',
    has_criminal_record: false,
    criminal_record_details: '',
  },
  vehicle: {
    type: null as VehicleType | null,
    service_type_slug: undefined as ServiceTypeSlug | undefined,
    make: '', model: '', year: '', color: '', plate_number: '', capacity: '',
    accepts_cargo: false, max_cargo_weight_kg: '',
    max_cargo_length_cm: '', max_cargo_width_cm: '', max_cargo_height_cm: '',
    accepted_cargo_categories: [] as PackageCategory[],
  },
  documents: INITIAL_DOCUMENTS.map((d) => ({ ...d })),
  driverProfileId: null as string | null,
};

export const useOnboardingStore = create<OnboardingState>((set) => ({
  ...INITIAL_STATE,

  setPersonalInfo: (info) =>
    set((s) => ({ personalInfo: { ...s.personalInfo, ...info } })),

  setVehicle: (vehicle) =>
    set((s) => ({ vehicle: { ...s.vehicle, ...vehicle } })),

  setDocumentUri: (type, uri, fileName, mimeType) =>
    set((s) => ({
      documents: s.documents.map((d) =>
        d.document_type === type ? { ...d, uri, fileName, mimeType: mimeType ?? null, uploaded: false, error: null } : d,
      ),
    })),

  setDocumentUploaded: (type) =>
    set((s) => ({
      documents: s.documents.map((d) =>
        d.document_type === type ? { ...d, uploaded: true, uploading: false } : d,
      ),
    })),

  setDocumentUploading: (type, uploading) =>
    set((s) => ({
      documents: s.documents.map((d) =>
        d.document_type === type ? { ...d, uploading } : d,
      ),
    })),

  setDocumentError: (type, error) =>
    set((s) => ({
      documents: s.documents.map((d) =>
        d.document_type === type ? { ...d, error, uploading: false } : d,
      ),
    })),

  setDriverProfileId: (id) => set({ driverProfileId: id }),

  reset: () =>
    set({
      personalInfo: {
        full_name: '',
        phone: '',
        email: '',
        identity_number: '',
        province: '',
        municipality: '',
        address: '',
        has_criminal_record: false,
        criminal_record_details: '',
      },
      vehicle: {
        type: null, make: '', model: '', year: '', color: '', plate_number: '', capacity: '',
        accepts_cargo: false, max_cargo_weight_kg: '',
        max_cargo_length_cm: '', max_cargo_width_cm: '', max_cargo_height_cm: '',
        accepted_cargo_categories: [],
      },
      documents: INITIAL_DOCUMENTS.map((d) => ({ ...d })),
      driverProfileId: null,
    }),
}));
