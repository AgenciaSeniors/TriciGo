// ============================================================
// TriciGo — Competitor adapter interface
//
// One adapter per competitor app (La Nave, Cinco). A change in La Nave's API
// touches exactly ONE file (la-nave.ts). The capturing EF
// (track-competitor-prices) only ever talks to this interface.
//
// Contract:
//   quoteAll(route, credential) resolves the competitor's fare-estimate endpoint
//   for the given route and returns the price for EVERY category it sees. The EF
//   then crosses those against competitor_category_map to decide which ones to
//   store and against which TriciGo service type.
//
// Failure isolation: an adapter NEVER throws. On any failure (timeout, 401,
// unexpected shape) it returns { ok: false, reason } so one competitor being
// down cannot stop the other, nor the own-price calculation. A 401/auth failure
// sets reason:'auth' so the caller can flag the session as expired.
// ============================================================

export interface CompetitorRoute {
  id: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
}

/** One category's price as the competitor reports it. */
export interface CompetitorCategoryQuote {
  /** The competitor's own raw category label, e.g. 'basico' / 'confort'. */
  category: string;
  /** Price in CUP, or null if that category was shown as unavailable. */
  price_cup: number | null;
}

export type CompetitorQuoteResult =
  | {
      ok: true;
      categories: CompetitorCategoryQuote[];
      /** Trimmed raw payload for debugging — PRICE/CATEGORY ONLY, never PII. */
      raw: unknown;
    }
  | {
      ok: false;
      /** 'auth' marks the session credential as no longer valid. */
      reason: 'auth' | 'timeout' | 'bad_response' | 'not_implemented' | 'error';
      detail?: string;
    };

export interface CompetitorAdapter {
  key: 'la_nave' | 'cinco';
  /**
   * Fetch the competitor's fare estimate for `route` as a logged-in user
   * (using `credential`), returning every category's price. Must never throw.
   */
  quoteAll(route: CompetitorRoute, credential: string): Promise<CompetitorQuoteResult>;
}
