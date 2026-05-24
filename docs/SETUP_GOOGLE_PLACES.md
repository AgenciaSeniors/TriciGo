# Setup: Google Places API for TriciGo search

PR 4 of the POI parity program. Google Places is the **primary** address search engine for TriciGo (best Cuban coverage); Mapbox SearchBox is the **fallback** when Google is unavailable or budget cap is reached.

This doc walks through:
1. Creating the Google Cloud project + API key
2. Setting up billing caps & alerts (target $500/mo max)
3. Deploying the API key to Supabase Edge Functions
4. Verifying the EF works end-to-end

---

## 1. Google Cloud Console — project + API key

### 1a. Create or open the project

1. Open https://console.cloud.google.com/
2. Top bar → project dropdown → "New Project"
   - Name: `TriciGo-Production` (or use existing)
   - Organization: your org (optional)
   - Location: No organization (or your org folder)
3. Select the project after creation

### 1b. Enable APIs

In the search bar at the top, search for and enable:
- **"Places API (New)"** — required for the new autocomplete + place details endpoints we use
- **"Geocoding API"** — optional, for future reverse geocoding fallback

Both are under the same billing umbrella.

### 1c. Create the API key

1. Navigate to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "API Key"
3. Copy the key value (looks like `AIzaSy...`) — **you'll only see it once**, save securely

### 1d. Restrict the API key (IMPORTANT)

Without restrictions, leaked keys can be abused for $$$. We use **API restrictions** (not application restrictions) because the key is used server-side by an Edge Function — there's no browser/app to restrict by.

In the credential settings:
1. **Application restrictions**: Select "None" (server-side only)
2. **API restrictions**:
   - Select "Restrict key"
   - Check: **Places API (New)** + **Geocoding API** (if enabled)
   - Uncheck everything else
3. Save

---

## 2. Billing caps & alerts (CRITICAL — protects the $500/mo budget)

Google has no hard cap by default — if your key gets abused or you misconfigure something, the bill grows uncapped. Set these alerts as the first line of defense.

### 2a. Set a budget

1. Navigate to "Billing" → "Budgets & alerts"
2. Click "Create Budget"
3. Configure:
   - Name: `TriciGo Google Places Monthly`
   - Scope: select your TriciGo project
   - Services: filter to "Places API (New)" + "Geocoding API"
   - Time range: Monthly
   - Budget amount: **$500.00 USD** (or your monthly cap)
4. Alerts (next page):
   - 60% → email (so you know we're at $300)
   - 90% → email + Slack webhook if configured (alarm at $450)
   - 100% → email + warn channel ($500 — should never hit if EF caps work)
5. Optional: enable "Connect this budget to Pub/Sub" if you want programmatic automation to disable APIs when over budget
6. Save

### 2b. Set hard cap (optional, prevents catastrophic bill)

Google **does not** support hard service caps natively, but you can:
1. Pub/Sub trigger from budget alert → Cloud Function → call Cloud Resource Manager API to disable Places API on the project
2. This is the "nuclear option" — implement if your CFO is risk-averse

For TriciGo's MVP, the EF-side daily counter cap (default 1000 calls/day) is enough protection. At $17/1000 Place Details + $2.83/1000 Autocomplete sessions, 1000/day = ~$15-20/day = $450-600/mo worst case.

---

## 3. Deploy the API key to Supabase Edge Functions

The key NEVER goes into client-side env. It lives only in the Supabase EF runtime as a secret.

### 3a. Set the secret

From your dev machine, with Supabase CLI installed:

```bash
cd /path/to/TriciGo
supabase secrets set GOOGLE_PLACES_API_KEY=AIzaSy...
```

Optional — override the default daily cap:
```bash
supabase secrets set GOOGLE_DAILY_CAP=1500
```

### 3b. Deploy the Edge Function

```bash
supabase functions deploy search-places-google
```

After deploy, the EF is available at:
```
https://<your-project-ref>.supabase.co/functions/v1/search-places-google
```

### 3c. Verify the EF is configured

```bash
# Should return 200 with empty results (auth required, no body sent)
curl -X POST \
  -H "Authorization: Bearer <any-user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"query":"capitolio"}' \
  https://<your-project-ref>.supabase.co/functions/v1/search-places-google
```

Expected: JSON with `data: [...]` array (Google results) OR `fallback: 'mapbox'` if the key is missing/invalid.

---

## 4. End-to-end verification

### 4a. In the app

1. Open the client (or driver) app on the device
2. Search for a known Cuban POI that's likely NOT in our local DB (e.g. "Cafetería Don Juan Habana")
3. Expected: Google result appears with "Powered by Google" attribution at the bottom of the dropdown
4. Search same query again immediately → should still work (now from cache)

### 4b. Check the Supabase cache table

```sql
-- See cached entries
SELECT query, hit_count, created_at FROM google_places_cache
ORDER BY created_at DESC LIMIT 10;

-- See today's API call count
SELECT * FROM google_places_daily_counter WHERE day = CURRENT_DATE;
```

### 4c. Monitor Google Cloud usage

1. Navigate to "APIs & Services" → "Dashboard" → "Places API (New)"
2. Charts show requests/day + cost — verify the trajectory matches expectations
3. After 24-48h: confirm cache hit rate is ≥60% (lower means the cache key is too fragmented)

---

## Cost projections (for reference)

| Volume | Sessions/mo | Cache hit rate | Real Google calls | Estimated cost |
|---|---|---|---|---|
| Startup (1k users) | 60k | 60% | 24k | $200 free + $0-50 |
| Growth (5k users) | 300k | 60% | 120k | ~$2,000 ⚠️ |
| Scale (10k users) | 1.2M | 70% | 360k | ~$4,000 ⚠️ |

At growth/scale, the EF daily counter cap kicks in (default 1000/day = 30k/mo) → degrades to Mapbox-only for the remainder of the day. Adjust `GOOGLE_DAILY_CAP` based on actual usage patterns and budget tolerance.

---

## Troubleshooting

### "Edge Function returns 503"
- Check secrets: `supabase secrets list` — `GOOGLE_PLACES_API_KEY` must be set
- Check EF logs: `supabase functions logs search-places-google`

### "Google returns INVALID_ARGUMENT"
- API key restrictions may be too strict — verify "Places API (New)" is checked under API restrictions
- Field mask in `_shared/google.ts` may need updating if Google changes the schema

### "Costs are higher than expected"
- Check the cache hit rate in `google_places_daily_counter` (cache_hits vs call_count)
- If hit rate <40%, the cache key may be too granular — increase proximity rounding from 2 decimals to 1 in `_shared/google.ts:computeCacheKey`
- Consider lowering `GOOGLE_DAILY_CAP` to force earlier fallback to Mapbox

### "App search shows 'No results' even for known places"
- EF may be returning `fallback: 'mapbox'` because the key is missing or budget cap hit
- Check `supabase functions logs search-places-google`
- Verify the user is authenticated (anon users get 401 from the EF)

---

## Related files

- `supabase/functions/search-places-google/index.ts` — EF entry point
- `supabase/functions/search-places-google/_shared/google.ts` — Google API client
- `supabase/migrations/00304_google_places_cache.sql` — cache + counter tables
- `packages/utils/src/geo.ts` — `searchAddressGoogle` + `searchAddressUnified` helpers
- `packages/ui/src/SourceAttribution.tsx` — TOS attribution component
