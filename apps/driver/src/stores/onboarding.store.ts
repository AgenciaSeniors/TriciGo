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

/**
 * Minimal shape of a `driver_documents` row needed to hydrate a draft. Kept
 * structural (not the full DriverDocument) so the store stays independent of
 * the DB row type.
 */
export interface ServerDocumentSummary {
  document_type: string;
  file_name?: string | null;
  mime_type?: string | null;
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
  hydrateUploadedDocuments: (serverDocs: ServerDocumentSummary[]) => void;
  setDriverProfileId: (id: string) => void;
  reset: () => void;
}

// Document requirements (product decision 2026-07-03):
//   national_id            — REQUIRED
//   selfie                 — REQUIRED  (re-added; see note below)
//   drivers_license        — REQUIRED  (was optional until 2026-06-30; now required)
//   operating_license      — OPTIONAL  (licencia operativa; new)
//   vehicle_registration   — REQUIRED
//   vehicle_photo          — REQUIRED
//
// SELFIE — manual review only (NOT biometric). CC-04 (2026-05-23) had removed
// selfie because the old onboarding step called `verify-selfie`, which returned
// random pass scores when SELFIE_VERIFICATION_ENABLED was unset (fake security).
// It is re-added here as a plain photo the admin compares against the ID by hand,
// exactly like every other document — the onboarding flow does NOT call
// `verify-selfie`, so no fake verification is reintroduced. The `selfie_checks`
// table + `verify-selfie` edge function stay dormant for a future AWS Rekognition
// (or equivalent) integration; SELFIE_VERIFICATION_ENABLED remains OFF.
//
// The `optional` flag gates progression: Submit enables once every NON-optional
// doc is uploaded. Kept in sync with the admin approval gate REQUIRED_DOC_TYPES
// (apps/admin/.../drivers/[id]/page.tsx) and the auto-admin EF REQUIRED_DOCS.
const INITIAL_DOCUMENTS: DocumentDraft[] = [
  { document_type: 'national_id', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null },
  { document_type: 'selfie', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null },
  { document_type: 'drivers_license', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null },
  { document_type: 'operating_license', uri: '', fileName: '', mimeType: null, uploaded: false, uploading: false, error: null, optional: true },
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

  /**
   * Mark drafts as uploaded for documents that already exist on the server.
   *
   * This store is in-memory only: an app restart mid-onboarding wipes every
   * `uploaded` flag while the files are still in `driver_documents`. Without
   * hydration the Documents step shows everything as missing, so drivers
   * re-upload the same files on every attempt and — if even one doc never
   * lands — Submit stays disabled forever (the selfie dead-end that blocked
   * a real driver's registration, 2026-07-17).
   *
   * Only PRISTINE drafts are touched. A draft that is uploading, already
   * uploaded, re-picked this session (uri set), or holding an error keeps its
   * local state: the session's progress always wins over the server snapshot,
   * so hydration can never clobber an in-flight upload or hide a real error.
   */
  hydrateUploadedDocuments: (serverDocs) =>
    set((s) => {
      // Latest row per type. Callers pass newest-first (getDocuments orders by
      // uploaded_at desc), and uploadDocument INSERTs a new row per attempt —
      // so keep the FIRST occurrence and ignore the older re-upload rows.
      const latest = new Map<string, ServerDocumentSummary>();
      for (const doc of serverDocs) {
        if (!latest.has(doc.document_type)) latest.set(doc.document_type, doc);
      }

      return {
        documents: s.documents.map((d) => {
          const isPristine = d.uri === '' && !d.uploaded && !d.uploading && !d.error;
          if (!isPristine) return d;
          const server = latest.get(d.document_type);
          if (!server) return d;
          return {
            ...d,
            uploaded: true,
            fileName: server.file_name ?? '',
            mimeType: server.mime_type ?? null,
          };
        }),
      };
    }),

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
