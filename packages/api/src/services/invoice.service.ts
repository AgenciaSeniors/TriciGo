// ============================================================
// TriciGo — Invoice Service
// Generates invoice data for corporate accounts.
// PDF rendering is done client-side with jsPDF.
// ============================================================

import { getSupabaseClient } from '../client';
import { corporateService } from './corporate.service';

export interface InvoiceLineItem {
  date: string;
  employee_name: string;
  employee_phone: string;
  ride_id: string;
  fare_trc: number;
}

export interface InvoiceData {
  account_name: string;
  tax_id: string | null;
  contact_email: string | null;
  contact_phone: string;
  period: string; // "March 2026"
  year: number;
  month: number;
  items: InvoiceLineItem[];
  total_rides: number;
  total_trc: number;
  budget_trc: number;
  generated_at: string;
}

export const invoiceService = {
  async generateMonthlyInvoice(
    accountId: string,
    year: number,
    month: number,
  ): Promise<InvoiceData> {
    const supabase = getSupabaseClient();

    // Get account info
    const account = await corporateService.getAccount(accountId);
    if (!account) throw new Error('ACCOUNT_NOT_FOUND');

    // Get rides for the period
    const start = new Date(year, month - 1, 1).toISOString();
    const end = new Date(year, month, 0, 23, 59, 59).toISOString();

    const { data: rides, error } = await supabase
      .from('corporate_rides')
      .select('ride_id, employee_user_id, fare_trc, created_at')
      .eq('corporate_account_id', accountId)
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Get employee names
    const { data: employees } = await supabase
      .from('corporate_employees')
      .select('user_id, users(full_name, phone)')
      .eq('corporate_account_id', accountId);

    const empMap = new Map<string, { name: string; phone: string }>();
    for (const emp of employees ?? []) {
      const u = emp.users as unknown as { full_name: string; phone: string } | null;
      empMap.set(emp.user_id, {
        name: u?.full_name || 'Sin nombre',
        phone: u?.phone || '',
      });
    }

    const items: InvoiceLineItem[] = (rides ?? []).map((r) => {
      const info = empMap.get(r.employee_user_id) ?? { name: r.employee_user_id, phone: '' };
      return {
        date: r.created_at,
        employee_name: info.name,
        employee_phone: info.phone,
        ride_id: r.ride_id,
        fare_trc: r.fare_trc,
      };
    });

    const totalTrc = items.reduce((sum, i) => sum + i.fare_trc, 0);

    const monthNames = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];

    return {
      account_name: account.name,
      tax_id: account.tax_id,
      contact_email: account.contact_email,
      contact_phone: account.contact_phone,
      period: `${monthNames[month - 1]} ${year}`,
      year,
      month,
      items,
      total_rides: items.length,
      total_trc: totalTrc,
      budget_trc: account.monthly_budget_trc,
      generated_at: new Date().toISOString(),
    };
  },
};
