'use client';

// ============================================================
// Address search for /admin/partners.
//
// Deliberately NOT a copy of apps/web AddressAutocomplete (994 lines). The
// quality lives in the search engine in @tricigo/utils — Google through the
// Supabase Edge Function, plus the Cuban street and POI RPCs — not in that
// component's chrome. The panel needs no saved locations, no ride-history
// predictions and no cross-street completion, so this consumes the same engine
// with a fraction of the surface and returns the same results.
//
// NO MAPBOX TOKEN NEEDED, and that is load-bearing: the admin deploy workflow
// never passes NEXT_PUBLIC_MAPBOX_TOKEN (a mapbox-gl screen once shipped as an
// empty box in every deployed build because of it). searchAddressUnified hits
// Google through the Edge Function first and only falls back to Mapbox, and
// searchAddressSearchBox returns [] when there is no token — so the fallback
// no-ops silently instead of breaking.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { getSupabaseClient } from '@tricigo/api';
import {
  searchAddressUnified,
  searchStreetsSupabase,
  searchPoisSupabase,
  dedupeSearchResults,
  rankSearchResults,
  searchResultCap,
  searchResultEmoji,
  SEARCH_DEBOUNCE_MS,
  type SearchBoxResult,
} from '@tricigo/utils';

interface Props {
  /** Biases results toward the form's current point. Without it "Reina" can
   *  return a street 300 km away. */
  proximity: { latitude: number; longitude: number };
  onSelect: (r: { address: string; latitude: number; longitude: number }) => void;
  inputClassName?: string;
}

const MIN_QUERY = 2;
const CACHE_MAX = 30;

export default function AdminAddressSearch({ proximity, onSelect, inputClassName = '' }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchBoxResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, SearchBoxResult[]>>(new Map());

  // Proximity changed (the admin moved the pin) → cached rows were ranked
  // against the old point and would now be misordered.
  useEffect(() => { cacheRef.current.clear(); }, [proximity.latitude, proximity.longitude]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async (q: string, signal: AbortSignal) => {
    const supabase = getSupabaseClient();
    const [unified, pois, streets] = await Promise.all([
      searchAddressUnified(q, supabase, proximity, signal, 8).catch(() => [] as SearchBoxResult[]),
      searchPoisSupabase(q, proximity, 5, signal).catch(() => [] as SearchBoxResult[]),
      // NOTE: searchStreetsSupabase takes no AbortSignal (verified). Its result
      // cannot be cancelled, so the lastQueryRef guard below — not the abort —
      // is what keeps a slow reply from overwriting a newer search.
      searchStreetsSupabase(q, proximity, 5).catch(() => [] as SearchBoxResult[]),
    ]);

    // Google rows win; suppress cuba_pois/street rows that duplicate them.
    const merged = [...unified, ...dedupeSearchResults(unified, [...pois, ...streets])];

    // Cross-street suggestions arrive with NaN coordinates and needsResolution
    // on purpose (00546): in the app they complete the text field. Here a row
    // IS a location, so an unfinite one would save a business at NaN, NaN.
    const located = merged.filter(
      (r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude),
    );

    return rankSearchResults(located, q, proximity).slice(0, searchResultCap(q));
  }, [proximity]);

  const handleChange = (text: string) => {
    setQuery(text);
    abortRef.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = text.trim();
    lastQueryRef.current = q;
    if (q.length < MIN_QUERY) { setResults([]); setLoading(false); setOpen(false); return; }

    const cached = cacheRef.current.get(q);
    if (cached) { setResults(cached); setOpen(true); setLoading(false); return; }

    setLoading(true);
    setOpen(true);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      void run(q, controller.signal)
        .then((rows) => {
          // Drop a stale reply: the admin kept typing while this was in flight.
          if (lastQueryRef.current !== q || controller.signal.aborted) return;
          cacheRef.current.set(q, rows);
          if (cacheRef.current.size > CACHE_MAX) {
            cacheRef.current.delete(cacheRef.current.keys().next().value as string);
          }
          setResults(rows);
        })
        .catch(() => { if (lastQueryRef.current === q) setResults([]); })
        .finally(() => { if (lastQueryRef.current === q) setLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
  };

  const choose = (r: SearchBoxResult) => {
    onSelect({
      address: r.address || r.place_name,
      latitude: r.latitude,
      longitude: r.longitude,
    });
    setQuery(r.place_name || r.address);
    setOpen(false);
    setResults([]);
  };

  const clear = () => {
    abortRef.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    lastQueryRef.current = '';
    setQuery(''); setResults([]); setOpen(false); setLoading(false);
  };

  return (
    <div className="relative">
      <label className="text-sm text-ink">Buscar el negocio o la dirección</label>
      <div className="relative mt-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
        <input
          className={`${inputClassName} !mt-0 pl-9 pr-9`}
          placeholder="Sylvain, Calle 23, Belascoaín…"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          // Blur is delayed so a click on a row lands before the list unmounts.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-subtle" />}
        {!loading && query.length > 0 && (
          <button
            type="button"
            onClick={clear}
            aria-label="Limpiar la búsqueda"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-subtle hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {open && !loading && results.length === 0 && query.trim().length >= MIN_QUERY && (
        <div className="absolute z-[1000] mt-1 w-full rounded-lg border border-line bg-surface p-3 text-sm text-ink-subtle shadow-lg">
          Sin resultados. Prueba con menos palabras, o marca el punto en el mapa.
        </div>
      )}

      {open && results.length > 0 && (
        // z-index above Leaflet's panes (which sit at 400-700).
        <ul className="absolute z-[1000] mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
          {results.map((r, i) => (
            <li key={`${r.place_name}-${r.latitude}-${r.longitude}-${i}`}>
              <button
                type="button"
                // onMouseDown, not onClick: the input's blur fires first and
                // would close the list before a click could register.
                onMouseDown={(e) => { e.preventDefault(); choose(r); }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-sunken"
              >
                <span className="mt-0.5 text-base leading-none">{searchResultEmoji(r)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{r.place_name || r.address}</span>
                  {r.address && r.address !== r.place_name && (
                    <span className="block truncate text-xs text-ink-subtle">{r.address}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
