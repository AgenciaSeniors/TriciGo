import { create } from 'zustand';
import type { VehicleType, DocumentType } from '@tricigo/types';

interface PersonalInfoDraft {
  full_name: string;
  email: string;
}

interface VehicleDraft {
  type: VehicleType | null;
  make: string;
  model: string;
  year: string;
  color: string;
  plate_number: string;
  capacity: string;
  accepts_cargo: boolean;
  max_cargo_weight_kg: string;
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
  personalInfo: { full_name: '', email: '' },
  vehicle: { type: null as VehicleType | null, make: '', model: '', year: '', color: '', plate_number: '', capacity: '', accepts_cargo: false, max_cargo_weight_kg: '' },
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
      personalInfo: { full_name: '', email: '' },
      vehicle: { type: null, make: '', model: '', year: '', color: '', plate_number: '', capacity: '' },
      documents: INITIAL_DOCUMENTS.map((d) => ({ ...d })),
      driverProfileId: null,
    }),
}));
