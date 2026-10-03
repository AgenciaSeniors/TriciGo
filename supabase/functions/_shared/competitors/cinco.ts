// ============================================================
// TriciGo — Cinco adapter (STUB until Phase 0 reconnaissance)
//
// This adapter is intentionally not wired to a real endpoint yet. Phase 0 of the
// plan (docs/superpowers/specs — competitor price observatory) is the owner
// capturing Cinco's fare-estimate request from their own Android with their
// own account (mitmproxy). Only then do we know: the endpoint URL, the auth
// header shape, the request body shape (lat/lng vs place_id), and the response
// shape (where each category's price lives).
//
// Until that entregable exists, quoteAll returns { ok:false, reason:'not_implemented' }
// so the EF runs end-to-end (schema, own-price calc, persistence, watchdog) with
// competitor_price_cup = NULL — a valid "not available" datum, not a crash.
//
// TO WIRE IT (Phase 3): fill buildQuoteRequest() and parseQuoteResponse() below
// from the Phase 0 document. Keep the try/catch so this never throws. Trim `raw`
// to price/category fields only — NEVER driver names, phones, or plates.
//
// Cinco is the recommended app to wire FIRST: smaller apps rarely pin their
// certificate, so Phase 0 is more likely to succeed here than on La Nave.
// ============================================================

import type { CompetitorAdapter, CompetitorRoute, CompetitorQuoteResult } from './types.ts';

const REQUEST_TIMEOUT_MS = 8_000;

// deno-lint-ignore no-unused-vars
function buildQuoteRequest(route: CompetitorRoute, credential: string): Request | null {
  // TODO(Phase 0): construct the real request from the captured endpoint.
  //   return new Request('https://<cinco-host>/<estimate-path>', {
  //     method: 'POST',
  //     headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
  //     body: JSON.stringify({ origin: {...}, destination: {...} }),
  //   });
  return null;
}

// deno-lint-ignore no-unused-vars
function parseQuoteResponse(json: unknown): CompetitorQuoteResult {
  // TODO(Phase 0): map the response to { ok:true, categories:[{category, price_cup}], raw }.
  // `raw` must contain price/category fields only — strip any driver/vehicle PII.
  return { ok: false, reason: 'not_implemented' };
}

export const cincoAdapter: CompetitorAdapter = {
  key: 'cinco',
  async quoteAll(route: CompetitorRoute, credential: string): Promise<CompetitorQuoteResult> {
    try {
      const request = buildQuoteRequest(route, credential);
      if (!request) return { ok: false, reason: 'not_implemented' };

      const res = await fetch(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
      if (!res.ok) return { ok: false, reason: 'bad_response', detail: `HTTP ${res.status}` };

      const json = await res.json();
      return parseQuoteResponse(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const reason = msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('abort')
        ? 'timeout'
        : 'error';
      return { ok: false, reason, detail: msg };
    }
  },
};
