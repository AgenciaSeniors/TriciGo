import type { IncidentReport, IncidentType } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const incidentService = {
  async createSOSReport(params: {
    ride_id: string;
    reported_by: string;
    against_user_id?: string;
    description: string;
  }): Promise<IncidentReport> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('incident_reports')
      .insert({
        ride_id: params.ride_id,
        reported_by: params.reported_by,
        against_user_id: params.against_user_id ?? null,
        type: 'sos',
        severity: 'critical',
        description: params.description,
        status: 'open',
      })
      .select()
      .single();
    if (error) throw error;
    return data as IncidentReport;
  },

  /**
   * Create a safety report (non-emergency). For post-trip or general safety concerns.
   */
  async createSafetyReport(params: {
    ride_id?: string;
    reported_by: string;
    against_user_id?: string;
    type: IncidentType;
    description: string;
  }): Promise<IncidentReport> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('incident_reports')
      .insert({
        ride_id: params.ride_id ?? null,
        reported_by: params.reported_by,
        against_user_id: params.against_user_id ?? null,
        type: params.type,
        severity: params.type === 'sos' ? 'critical' : 'medium',
        description: params.description,
        status: 'open',
      })
      .select()
      .single();
    if (error) throw error;
    return data as IncidentReport;
  },

  async getIncidentsForRide(rideId: string): Promise<IncidentReport[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('incident_reports')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as IncidentReport[];
  },

  async getMyIncidents(userId: string): Promise<IncidentReport[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('incident_reports')
      .select('*')
      .eq('reported_by', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as IncidentReport[];
  },
};
