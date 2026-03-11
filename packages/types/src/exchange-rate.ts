// ============================================================
// TriciGo — Exchange Rate Types
// ============================================================

/** Exchange rate record from the exchange_rates table */
export interface ExchangeRate {
  id: string;
  /** Source of the rate: ElToque API or manual admin entry */
  source: 'eltoque_api' | 'manual';
  /** How many CUP per 1 USD (e.g. 520 means 1 USD = 520 CUP) */
  usd_cup_rate: number;
  /** When the rate was fetched/set */
  fetched_at: string;
  /** Whether this is the current active rate */
  is_current: boolean;
  created_at: string;
}
