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
  uploaded: boolean;
  uploading: boolean;
  error: string | null;
}

interface OnboardingState {
  personalInfo: PersonalInfoDraft;
  vehicle: VehicleDraft;
  documents: DocumentDraft[];
  driverProfileId: string | null;

  setPersonalInfo: (info: Partial<PersonalInfoDraft>) => void;
  setVehicle: (vehicle: Partial<VehicleDraft>) => void;
  setDocumentUri: (type: DocumentType, uri: string, fileName: string) => void;
  setDocumentUploaded: (type: DocumentType) => void;
  setDocumentUploading: (type: DocumentType, uploading: boolean) => void;
  setDocumentError: (type: DocumentType, error: string | null) => void;
  setDriverProfileId: (id: string) => void;
  reset: () => void;
}

const INITIAL_DOCUMENTS: DocumentDraft[] = [
  { document_type: 'national_id', uri: '', fileName: '', uploaded: false, uploading: false, error: null },
  { document_type: 'drivers_license', uri: '', fileName: '', uploaded: false, uploading: false, error: null },
  { document_type: 'vehicle_registration', uri: '', fileName: '', uploaded: false, uploading: false, error: null },
  { document_type: 'selfie', uri: '', fileName: '', uploaded: false, uploading: false, error: null },
  { document_type: 'vehicle_photo', uri: '', fileName: '', uploaded: false, uploading: false, error: null },
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

  setDocumentUri: (type, uri, fileName) =>
    set((s) => ({
      documents: s.documents.map((d) =>
        d.document_type === type ? { ...d, uri, fileName, uploaded: false, error: null } : d,
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
