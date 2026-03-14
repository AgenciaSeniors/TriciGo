// ============================================================
// TriciGo — Corporate Account Types
// ============================================================

export type CorporateAccountStatus = 'pending' | 'approved' | 'suspended' | 'rejected';

export type CorporateEmployeeRole = 'admin' | 'employee';

export interface CorporateAccount {
  id: string;
  name: string;
  contact_phone: string;
  contact_email: string | null;
  tax_id: string | null;
  status: CorporateAccountStatus;
  created_by: string;
  monthly_budget_trc: number;
  per_ride_cap_trc: number;
  allowed_service_types: string[];
  allowed_hours_start: string | null;
  allowed_hours_end: string | null;
  current_month_spent: number;
  approved_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CorporateEmployee {
  id: string;
  corporate_account_id: string;
  user_id: string;
  role: CorporateEmployeeRole;
  is_active: boolean;
  added_by: string;
  created_at: string;
}

export interface CorporateEmployeeWithUser extends CorporateEmployee {
  users: { full_name: string; phone: string };
}

export interface CorporateRide {
  id: string;
  corporate_account_id: string;
  ride_id: string;
  employee_user_id: string;
  fare_trc: number;
  created_at: string;
}

export interface CorporateBillingSummary {
  total_rides: number;
  total_spent_trc: number;
  budget_remaining_trc: number;
}
