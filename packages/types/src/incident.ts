// ============================================================
// TriciGo — Incident & Safety Types
// ============================================================

import type { IncidentSeverity, IncidentStatus, IncidentType } from './enums';

export interface IncidentReport {
  id: string;
  ride_id: string | null;
  reported_by: string;
  against_user_id: string | null;
  type: IncidentType;
  severity: IncidentSeverity;
  description: string;
  evidence_urls: string[];
  status: IncidentStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SOSAlert {
  ride_id: string;
  user_id: string;
  location: {
    latitude: number;
    longitude: number;
  };
  triggered_at: string;
}
