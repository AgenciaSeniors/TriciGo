'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { haversineDistance, lookupIntersectionPoint, searchAddressSearchBox, searchAddressUnified, newSessionToken, searchPoisSupabase, searchStreetsSupabase, computeSpecificity, stripAccents, fuzzyMatch, isGenericStreetAddress, parseCubanAddress, suggestCrossStreetsSupabase, importPoiFromSearch, searchResultEmoji, rankSearchResults, searchResultCap, SEARCH_DEBOUNCE_MS, isProviderStreetResult, filterProviderStreetsByLocalAnchor } from '@tricigo/utils';
import type { SearchBoxResult, CubanParsed } from '@tricigo/utils';
import { getSupabaseClient } from '@tricigo/api';

// suggestCrossStreets and parseCubanAddress imported from @tricigo/utils (Supabase-backed, ~5ms)

interface AddressResult {
  address: string;
  latitude: number;
  longitude: number;
  place_name: string;
  /** 00544: cross-street NAME suggestion with no geometry (lat/lng are NaN).
   *  handleSelect completes the input instead of committing it. */
  needsResolution?: boolean;
  category?: string;
  /** PR J (2026-05-25): tricigo-vocabulary category (hotel, restaurant,
   *  gas_station, etc.) populated by the providers via
   *  mapExternalCategoryToTricigo (Google/Mapbox) or directly by
   *  search_pois_smart (cuba_pois). Drives the per-row emoji icon. */
  tricigoCategory?: string | null;
  source?: 'searchbox' | 'nominatim' | 'supabase' | 'google' | 'mapbox';
  specificity?: number;
  /** PR 4b: original SearchBoxResult for background importPoiFromSearch.
   *  Populated only for unified (Google/Mapbox) rows. */
  _src?: SearchBoxResult;
}

interface SavedLocationItem {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface AddressAutocompleteProps {
  label?: string;
  placeholder?: string;
  value?: string;
  onSelect: (result: AddressResult) => void;
  onClear?: () => void;
  mapboxToken: string;
  savedLocations?: SavedLocationItem[];
  /** Predicted destinations from ride history (shown as a tier when the field
   *  is empty, like the mobile AddressSearchInput priority tier). */
  predictions?: { address: string; latitude: number; longitude: number }[];
  proximity?: { latitude: number; longitude: number };
  /** Label-only cross-street enrichment. Must NOT return coordinates: rows keep their own. */
  enrichAddress?: (lat: number, lng: number) => Promise<{ address: string } | null>;
}

function getSavedIcon(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('casa') || lower.includes('home')) return '🏠';
  if (lower.includes('trabajo') || lower.includes('work') || lower.includes('oficina')) return '🏢';
  if (lower.includes('gym') || lower.includes('gimnasio')) return '🏋️';
  if (lower.includes('escuela') || lower.includes('school') || lower.includes('universidad')) return '🎓';
  return '⭐';
}

// CubanParsed and parseCubanAddress imported from @tricigo/utils

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query || query.length < 1) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <strong style={{ color: 'var(--primary)', fontWeight: 700 }}>{text.slice(idx, idx + query.length)}</strong>
      {text.slice(idx + query.length)}
    </>
  );
}

function getResultIcon(result: AddressResult): string {
  return searchResultEmoji(result);
}

/** Remove place_name from full address to avoid duplication in secondary line */
function formatSecondaryAddress(result: AddressResult): string {
  const full = result.address || '';
  const name = result.place_name || '';
  if (full.toLowerCase().startsWith(name.toLowerCase())) {
    const rest = full.slice(name.length).replace(/^[,\s]+/, '');
    return rest || full;
  }
  if (full === name) return '';
  return full;
}

export function AddressAutocomplete({ label, placeholder, value, onSelect, onClear, mapboxToken, savedLocations, predictions, proximity, enrichAddress }: AddressAutocompleteProps) {
  const { t } = useTranslation('web');
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const searchIdRef = useRef(0); // Race condition prevention
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useRef(`address-listbox-${Math.random().toString(36).slice(2, 9)}`).current;
  const mapboxCacheRef = useRef<Map<string, AddressResult[]>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const isSelectingRef = useRef(false);
  // PR C of POI parity — Google Places session token. Lazy-init on first
  // keystroke, reset on select / clear / empty input. Reused for every
  // keystroke + the Place Details lookup in one billable session.
  const sessionTokenRef = useRef<string | null>(null);
  const [recentAddresses, setRecentAddresses] = useState<AddressResult[]>([]);

  // Clear Mapbox cache when proximity changes (results are location-dependent)
  useEffect(() => {
    mapboxCacheRef.current.clear();
  }, [proximity?.latitude, proximity?.longitude]);

  // Load recent addresses from localStorage on mount (with validation)
  useEffect(() => {
    try {
      const stored = localStorage.getItem('tricigo_recent_addresses');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setRecentAddresses(parsed.filter((r: unknown): r is AddressResult => {
            if (!r || typeof r !== 'object') return false;
            const x = r as Record<string, unknown>;
            return typeof x.latitude === 'number' && isFinite(x.latitude as number)
              && typeof x.longitude === 'number' && isFinite(x.longitude as number)
              && typeof x.place_name === 'string';
          }));
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Update query when value prop changes
  useEffect(() => {
    if (value !== undefined) setQuery(value);
  }, [value]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Animate dropdown open/close
  useEffect(() => {
    if (isOpen) {
      // Trigger opacity transition on next frame
      requestAnimationFrame(() => setDropdownVisible(true));
    } else {
      setDropdownVisible(false);
    }
  }, [isOpen]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listboxRef.current) {
      const item = listboxRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  async function searchNominatimEnhanced(q: string, prox?: { latitude: number; longitude: number }, signal?: AbortSignal): Promise<AddressResult[]> {
    // Own timeout so a stalled 3G request can't hang the search spinner forever
    // (this is a direct external fetch, outside the Supabase client's timeout
    // wrapper). Combine it with the caller's abort signal.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      // Use all-Cuba viewbox — Nominatim still filters by countrycodes=cu
      const viewbox = '-84.95,19.8,-74.13,23.3'; // All Cuba
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&countrycodes=cu&limit=8&viewbox=${viewbox}&bounded=0&addressdetails=1&namedetails=1&extratags=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'es' }, signal: ctrl.signal });
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((item: any) => {
        // Use namedetails for specific POI names when available
        const nameFromDetails = item.namedetails?.name || item.namedetails?.['name:es'] || '';
        const genericName = item.name || item.display_name?.split(',')[0] || '';
        // Prefer the more specific name
        const placeName = nameFromDetails.length > genericName.length ? nameFromDetails : genericName;
        // Build category from OSM class/type
        const category = item.type || item.class || '';
        const fullAddress = ((item.display_name || '').split(', ').slice(0, 3).join(', '));

        return {
          address: fullAddress,
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
          place_name: placeName,
          category,
          source: 'nominatim' as const,
          specificity: computeSpecificity(placeName),
        };
      });
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // PR 4 of POI parity — Google Places (best Cuban coverage) → Mapbox
  // SearchBox fallback via the unified helper. We cache the merged
  // results so subsequent same-query renders skip both providers.
  const fetchSearchBox = useCallback(async (q: string, signal?: AbortSignal): Promise<AddressResult[]> => {
    const cached = mapboxCacheRef.current.get(q);
    if (cached) return cached;
    try {
      const results = await searchAddressUnified(q, getSupabaseClient(), proximity ?? null, signal, 10, sessionTokenRef.current ?? undefined);
      const items: AddressResult[] = results.map(r => ({
        address: r.full_address || r.address,
        latitude: r.latitude,
        longitude: r.longitude,
        place_name: r.place_name,
        category: r.category,
        tricigoCategory: r.tricigoCategory ?? null,
        source: r.source === 'google' ? 'google'
          : r.source === 'mapbox' ? 'mapbox'
          : (r.source === 'overpass' ? 'nominatim' : r.source) as AddressResult['source'],
        specificity: r.specificity,
        // PR 4b: keep original SearchBoxResult so handleSelect can fire-and-forget
        // import-mapbox-poi for Google-sourced selections.
        _src: r,
      }));
      mapboxCacheRef.current.set(q, items);
      return items;
    } catch (err: any) {
      if (err?.name === 'AbortError') return [];
      // Hard fallback: if unified fails entirely, hit Mapbox SearchBox directly
      try {
        const fallback = await searchAddressSearchBox(q, proximity ?? null, signal, 10);
        return fallback.map(r => ({
          address: r.full_address || r.address,
          latitude: r.latitude,
          longitude: r.longitude,
          place_name: r.place_name,
          category: r.category,
          tricigoCategory: r.tricigoCategory ?? null,
          source: 'mapbox' as AddressResult['source'],
          specificity: r.specificity,
        }));
      } catch {
        return [];
      }
    }
  }, [proximity]);

  const search = useCallback(async (q: string) => {
    if (q.length < 1) { setResults([]); setIsOpen(false); return; }

    const thisSearchId = ++searchIdRef.current; // Track this search
    // Abort any in-flight requests from previous searches
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    try {
      const cubanParsed = parseCubanAddress(q);

      // ─── PATH 1: PARTIAL CUBAN (user typing "Lindero e/ Clavel y ") ───
      if (cubanParsed?.partial && proximity) {
        const crossStreets = await suggestCrossStreetsSupabase(cubanParsed.main, proximity);
        if (searchIdRef.current !== thisSearchId) return; // Stale — discard
        if (crossStreets.length > 0) {
          // TEXT COMPLETIONS, not places: suggest_cross_streets returns street
          // names with no geometry. needsResolution makes handleSelect complete
          // the input instead of committing; the NaN coordinates make sure a
          // path that ignored the flag fails loudly rather than booking a ride
          // to a plausible-looking wrong point. These used to carry `proximity`
          // — the rider's own position — which is how a destination silently
          // became an address ~1.5 km away.
          const suggestions: AddressResult[] = crossStreets.map(cs => {
            const addr = cubanParsed.partial === 'waiting_cross2'
              ? `${cubanParsed.main} e/ ${cubanParsed.cross1} y ${cs}`
              : `${cubanParsed.main} e/ ${cs}`;
            return { address: addr, latitude: NaN, longitude: NaN, place_name: addr, needsResolution: true };
          });
          setResults(suggestions.slice(0, 5));
          setIsOpen(true);
          setActiveIndex(-1);
          setLoading(false);
          return;
        }
      }

      // ─── PATH 2: COMPLETE CUBAN ("Reina entre Campanario y Lealtad") ───
      // ONLY run findIntersection — NO Mapbox (avoids irrelevant results)
      if (cubanParsed && !cubanParsed.partial && cubanParsed.cross1) {
        const intersection = await lookupIntersectionPoint(
          cubanParsed.main, cubanParsed.cross1, cubanParsed.cross2, proximity || undefined,
        );
        if (searchIdRef.current !== thisSearchId) return; // Stale
        if (intersection) {
          setResults([{
            address: intersection.address,
            latitude: intersection.latitude,
            longitude: intersection.longitude,
            place_name: intersection.address,
          }]);
          setIsOpen(true);
          setActiveIndex(-1);
          setLoading(false);
          return;
        }
        // Cuban intersection lookup failed — try searching by main street name instead
        // This gives contextual results rather than garbage from searching "X entre Y y Z"
        q = cubanParsed.main;
      }

      // ─── PATH 3: NORMAL SEARCH — Search Box + Supabase POIs + Supabase streets + Nominatim in parallel ───
      // 4 sources in parallel. searchStreetsSupabase is the local street corner
      // DB (search_streets RPC) — same authoritative source the mobile client
      // uses. Without it, when Google mis-shoots a Cuban street ("Calle 23" →
      // "Calle 230" 13 km away in Nuevo Vedado) we had no local anchor to fall
      // back on and the wrong pin won the ranking on `specificity`.
      const [searchBoxSettled, poisSettled, streetsSettled, nominatimSettled] = await Promise.allSettled([
        fetchSearchBox(q, controller.signal),
        searchPoisSupabase(q, proximity ?? null, 10, controller.signal).then(items =>
          items.map(r => ({
            address: r.full_address || r.address,
            latitude: r.latitude,
            longitude: r.longitude,
            place_name: r.place_name,
            category: r.category,
            tricigoCategory: r.tricigoCategory ?? null,
            source: 'supabase' as const,
            specificity: r.specificity,
          }))
        ),
        searchStreetsSupabase(q, proximity ?? null, 8).then(items =>
          items.map(r => ({
            address: r.address,
            latitude: r.latitude,
            longitude: r.longitude,
            place_name: r.place_name || r.address,
            category: r.category,
            tricigoCategory: r.tricigoCategory ?? null,
            source: 'supabase' as const,
            specificity: r.specificity,
          }))
        ),
        searchNominatimEnhanced(q, proximity, controller.signal),
      ]);
      if (searchIdRef.current !== thisSearchId) return;

      const searchBoxItems = searchBoxSettled.status === 'fulfilled' ? searchBoxSettled.value : [];
      const poiItems       = poisSettled.status === 'fulfilled' ? poisSettled.value : [];
      const streetItems    = streetsSettled.status === 'fulfilled' ? streetsSettled.value : [];
      const nominatimItems = nominatimSettled.status === 'fulfilled' ? nominatimSettled.value : [];

      // When the local street DB found the query, drop provider (Google/
      // Mapbox) street-shaped rows that land far from it — the dedupe below
      // misses Google's exact miss ("Calle 23" → "Calle 230", token overlap
      // 0.5) so the wrong coordinate slipped through and could win on
      // `specificity`. See filterProviderStreetsByLocalAnchor for the numbers.
      const localStreetAnchor = streetItems[0]
        ? { latitude: streetItems[0].latitude, longitude: streetItems[0].longitude }
        : null;
      const searchBoxVenues  = searchBoxItems.filter((r) => !isProviderStreetResult(r));
      const searchBoxStreets = searchBoxItems.filter(isProviderStreetResult);
      const trustedSearchBoxStreets = filterProviderStreetsByLocalAnchor(searchBoxStreets, localStreetAnchor);

      // ─── SMART DEDUPLICATION ───
      // Combine all results, then deduplicate by name similarity + proximity
      const allItems: AddressResult[] = [
        ...searchBoxVenues.map(r => ({ ...r, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
        ...trustedSearchBoxStreets.map(r => ({ ...r, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
        ...poiItems.map(r => ({ ...r, source: 'supabase' as const, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
        ...streetItems.map(r => ({ ...r, source: 'supabase' as const, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
        ...nominatimItems.map(r => ({ ...r, source: 'nominatim' as const, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
      ];

      // No distance filter here — Mapbox already filters by country=cu
      // Ranking by proximity is handled later in rankSearchResults()
      const filtered = allItems;

      // Deduplicate: group by name similarity + spatial proximity
      const deduped: AddressResult[] = [];
      const used = new Set<number>();
      for (let i = 0; i < filtered.length; i++) {
        if (used.has(i)) continue;
        let best = filtered[i]!;
        used.add(i);
        for (let j = i + 1; j < filtered.length; j++) {
          if (used.has(j)) continue;
          const other = filtered[j]!;
          const dist = haversineDistance(
            { latitude: best.latitude, longitude: best.longitude },
            { latitude: other.latitude, longitude: other.longitude },
          );
          const namesSimilar = fuzzyMatch(best.place_name, other.place_name, 0.25)
            || fuzzyMatch(other.place_name, best.place_name, 0.25);
          // Same name within 500m, or exact coordinates within 100m
          if ((namesSimilar && dist < 500) || dist < 100) {
            used.add(j);
            // Keep the one with higher specificity; prefer searchbox on tie
            if ((other.specificity ?? 0) > (best.specificity ?? 0)
              || ((other.specificity ?? 0) === (best.specificity ?? 0) && other.source === 'searchbox')) {
              best = other;
            }
          }
        }
        deduped.push(best);
      }

      let merged = deduped;

      // Fallback: if both empty and query has " y ", try as intersection
      if (merged.length === 0) {
        const yMatch = q.match(/^(.+?)\s+y\s+(.+)$/i);
        if (yMatch && yMatch[1].trim().length >= 2 && yMatch[2].trim().length >= 1) {
          try {
            const intersection = await lookupIntersectionPoint(yMatch[1].trim(), yMatch[2].trim(), undefined, proximity || undefined);
            if (searchIdRef.current !== thisSearchId) return;
            if (intersection) {
              merged = [{ address: intersection.address, latitude: intersection.latitude, longitude: intersection.longitude, place_name: intersection.address }];
            }
          } catch { /* ignore */ }
        }
      }

      // ─── MULTI-FACTOR RANKING (proximity-bucket dominant) ───
      if (merged.length > 1) {
        const normalizedQuery = stripAccents(q.toLowerCase().trim());
        merged = rankSearchResults(merged, normalizedQuery, proximity);
      }

      // Filter out invalid coordinates only — no distance limit (Cuba-wide app)
      merged = merged.filter(r => r.latitude && r.longitude && isFinite(r.latitude) && isFinite(r.longitude));

      const initial = merged.slice(0, searchResultCap(q));
      setResults(initial);
      setIsOpen(true);
      setActiveIndex(-1);

      // BACKGROUND: Enrich top 3 results with cross-streets
      if (enrichAddress && initial.length > 0) {
        const enrichPromises = initial.slice(0, 3).map(async (r, idx) => {
          try {
            const enriched = await enrichAddress(r.latitude, r.longitude);
            if (enriched && searchIdRef.current === thisSearchId) {
              // Only enrich generic streets (not named POIs like hotels/airports)
              const hasCrossStreets = enriched.address.includes(' e/ ') || enriched.address.includes(' entre ');
              const originalIsGeneric = isGenericStreetAddress(r.place_name || r.address);
              if (hasCrossStreets && originalIsGeneric) {
                // Label only — the row keeps its own coordinates. See
                // enrichWithCrossStreets(): re-resolving the point moved pins
                // to a fuzzy 5 km midpoint on an unrelated street.
                return { idx, place_name: enriched.address, address: r.address };
              }
            }
          } catch { /* ignore */ }
          return null;
        });
        Promise.allSettled(enrichPromises).then((settled) => {
          if (searchIdRef.current !== thisSearchId) return;
          setResults(prev => {
            const updated = [...prev];
            for (const s of settled) {
              if (s.status === 'fulfilled' && s.value) {
                const { idx, place_name, address } = s.value;
                if (updated[idx]) {
                  updated[idx] = { ...updated[idx], place_name, address };
                }
              }
            }
            return updated;
          });
        });
      }
    } catch {
      if (searchIdRef.current === thisSearchId) setResults([]);
    } finally {
      if (searchIdRef.current === thisSearchId) setLoading(false);
    }
  }, [proximity, fetchSearchBox, enrichAddress]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (val.length === 0) {
      setResults([]);
      setIsOpen(false);
      // Empty input ends the typeahead session.
      sessionTokenRef.current = null;
      return;
    }
    // Lazy-init the session token on the first non-empty keystroke.
    if (sessionTokenRef.current === null) {
      sessionTokenRef.current = newSessionToken();
    }
    debounceRef.current = setTimeout(() => search(val), SEARCH_DEBOUNCE_MS);
  }

  function saveToRecent(result: AddressResult) {
    try {
      const stored = localStorage.getItem('tricigo_recent_addresses');
      const recents: AddressResult[] = stored ? JSON.parse(stored) : [];
      // Remove duplicate if exists
      const filtered = recents.filter(r =>
        Math.abs(r.latitude - result.latitude) > 0.0001 || Math.abs(r.longitude - result.longitude) > 0.0001
      );
      // Add to front, keep max 5
      const updated = [result, ...filtered].slice(0, 5);
      localStorage.setItem('tricigo_recent_addresses', JSON.stringify(updated));
      setRecentAddresses(updated);
    } catch { /* ignore */ }
  }

  async function handleSelect(result: AddressResult) {
    if (isSelectingRef.current) return;

    // A cross-street suggestion is a TEXT COMPLETION with no geometry. Put it
    // back in the input and re-search: once it reads "X e/ Y y Z" the complete
    // Cuban-address path resolves real coordinates. Never commit these.
    if (result.needsResolution
        || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) {
      setQuery(result.place_name);
      setActiveIndex(-1);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => search(result.place_name), SEARCH_DEBOUNCE_MS);
      return;
    }

    isSelectingRef.current = true;
    setQuery(result.place_name); // Show immediately
    setIsOpen(false);
    setActiveIndex(-1);
    // Session ends on selection — drop the Google Places session token so
    // the next search starts a fresh billable session.
    sessionTokenRef.current = null;

    // If this is a Cuban address suggestion with "e/" pattern, resolve exact intersection coords
    const parsed = parseCubanAddress(result.place_name);
    if (parsed && !parsed.partial && parsed.cross1 && proximity) {
      try {
        const intersection = await lookupIntersectionPoint(parsed.main, parsed.cross1, parsed.cross2, proximity);
        if (intersection) {
          setQuery(intersection.address);
          const intersectionResult = {
            address: intersection.address,
            latitude: intersection.latitude,
            longitude: intersection.longitude,
            place_name: intersection.address,
          };
          saveToRecent(intersectionResult);
          onSelect(intersectionResult);
          isSelectingRef.current = false;
          return;
        }
      } catch { /* fallback below */ }
    }

    // For non-Cuban addresses: pass through immediately (no blocking enrichment).
    // The booking page will do background reverseGeocode to add cross-streets.
    // This prevents the bug where enriched address text didn't match pin coordinates.
    saveToRecent(result);
    onSelect(result);
    // PR 4b: background fire-and-forget — grow cuba_pois via Mapbox lookup
    // when the selection came from Google/Mapbox unified search.
    if (result._src) {
      void importPoiFromSearch(result._src, getSupabaseClient());
    }
    isSelectingRef.current = false;
  }

  function handleClear() {
    setQuery('');
    setResults([]);
    setIsOpen(false);
    setActiveIndex(-1);
    sessionTokenRef.current = null;
    inputRef.current?.focus();
    onClear?.();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && results[activeIndex]) {
          handleSelect(results[activeIndex]);
        } else if (results.length > 0) {
          handleSelect(results[0]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  const showNoResults = query.length >= 8 && !loading && results.length === 0 && isOpen;
  const hasSavedToShow = query.length === 0 && ((savedLocations && savedLocations.length > 0) || recentAddresses.length > 0 || (!!predictions && predictions.length > 0));
  const showDropdown = isOpen && (results.length > 0 || showNoResults || hasSavedToShow);
  const activeDescendant = activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div
      ref={containerRef}
      role="combobox"
      aria-expanded={showDropdown}
      aria-haspopup="listbox"
      aria-owns={listId}
      style={{ position: 'relative' }}
    >
      {label && (
        <label
          style={{
            display: 'block',
            marginBottom: '0.25rem',
            fontSize: '0.85rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
          }}
        >
          {label}
        </label>
      )}

      {/* Input wrapper */}
      <div style={{ position: 'relative' }}>
        {/* Search icon */}
        <div
          style={{
            position: 'absolute',
            left: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            color: 'var(--text-tertiary)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => {
            // Show saved locations when empty, or search results when typing
            if (query.length === 0 && ((savedLocations && savedLocations.length > 0) || recentAddresses.length > 0 || (!!predictions && predictions.length > 0))) {
              setIsOpen(true);
            } else if (results.length > 0 || (query.length >= 2 && !loading && results.length === 0)) {
              setIsOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || t('web.address_placeholder', { defaultValue: 'Buscar direccion...' })}
          aria-label={label || t('web.address_placeholder', { defaultValue: 'Buscar direccion...' })}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          style={{
            width: '100%',
            height: 48,
            paddingLeft: 40,
            paddingRight: loading || query ? 72 : 12,
            paddingTop: 0,
            paddingBottom: 0,
            borderRadius: showDropdown ? '12px 12px 0 0' : 12,
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            fontSize: '0.9rem',
            boxSizing: 'border-box',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            outline: 'none',
            transition: 'border-radius 0.15s ease',
          }}
        />

        {/* Right side: spinner + clear button */}
        <div
          style={{
            position: 'absolute',
            right: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {/* Loading spinner */}
          {loading && (
            <div
              style={{
                width: 18,
                height: 18,
                border: '2px solid var(--border)',
                borderTopColor: 'var(--primary)',
                borderRadius: '50%',
                animation: 'address-spin 0.6s linear infinite',
              }}
            />
          )}

          {/* Clear button */}
          {query.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: 'none',
                background: 'var(--border-light)',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
                padding: 0,
                transition: 'background 0.15s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--border)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'var(--border-light)')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <ul
          id={listId}
          ref={listboxRef}
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderTop: 'none',
            borderRadius: '0 0 12px 12px',
            zIndex: 100,
            maxHeight: 260,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            opacity: dropdownVisible ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
        >
          {/* Predicted destinations (from ride history) when query is empty */}
          {query.length === 0 && predictions && predictions.length > 0 && (
            <>
              <li style={{ padding: '0.5rem 0.75rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('web.suggested_destinations', { defaultValue: 'Sugeridos para ti' })}
              </li>
              {predictions.slice(0, 3).map((p, i) => (
                <li
                  key={`pred-${i}`}
                  role="option"
                  onClick={() => handleSelect({ address: p.address, latitude: p.latitude, longitude: p.longitude, place_name: p.address })}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.65rem 0.75rem', minHeight: 48, cursor: 'pointer', transition: 'background 0.1s ease' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(var(--primary-rgb, 255,140,0), 0.08)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ flexShrink: 0, fontSize: '1.1rem' }} aria-hidden="true">⭐</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.88rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.address}</div>
                  </div>
                </li>
              ))}
            </>
          )}
          {/* Saved locations when query is empty */}
          {query.length === 0 && savedLocations && savedLocations.length > 0 && (
            <>
              <li style={{ padding: '0.5rem 0.75rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('web.saved_locations_header', { defaultValue: 'Ubicaciones guardadas' })}
              </li>
              {savedLocations.map((loc, i) => (
                <li
                  key={`saved-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onClick={() => handleSelect({ address: loc.address, latitude: loc.latitude, longitude: loc.longitude, place_name: loc.label })}
                  onMouseEnter={() => setActiveIndex(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.65rem 0.75rem',
                    minHeight: 48,
                    cursor: 'pointer',
                    background: i === activeIndex ? 'rgba(var(--primary-rgb, 255,140,0), 0.08)' : 'transparent',
                    borderBottom: i < savedLocations.length - 1 ? '1px solid var(--border-light)' : 'none',
                    transition: 'background 0.1s ease',
                  }}
                >
                  <span style={{ flexShrink: 0, fontSize: '1.2rem' }} aria-hidden="true">{getSavedIcon(loc.label)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{loc.label}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc.address}</div>
                  </div>
                </li>
              ))}
            </>
          )}
          {/* Recent addresses when query is empty */}
          {query.length === 0 && recentAddresses.length > 0 && (
            <>
              <li style={{ padding: '0.5rem 0.75rem', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Recientes
              </li>
              {recentAddresses.map((r, i) => (
                <li
                  key={`recent-${i}`}
                  role="option"
                  onClick={() => handleSelect(r)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.65rem 0.75rem',
                    minHeight: 48,
                    cursor: 'pointer',
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(var(--primary-rgb, 255,140,0), 0.08)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ flexShrink: 0, fontSize: '1.1rem' }} aria-hidden="true">🕐</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.88rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.place_name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.address}</div>
                  </div>
                </li>
              ))}
            </>
          )}
          {/* Search results */}
          {query.length > 0 && results.length > 0 ? (
            results.map((r, i) => (
              <li
                key={i}
                id={`${listId}-option-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onClick={() => handleSelect(r)}
                onMouseEnter={() => setActiveIndex(i)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.6rem',
                  padding: '0.65rem 0.75rem',
                  minHeight: 48,
                  cursor: 'pointer',
                  background: i === activeIndex ? 'rgba(var(--primary-rgb, 255,140,0), 0.08)' : 'transparent',
                  borderBottom: i < results.length - 1 ? '1px solid var(--border-light)' : 'none',
                  transition: 'background 0.1s ease',
                  boxSizing: 'border-box',
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: '1.1rem',
                    lineHeight: '1.4',
                    marginTop: '0.05rem',
                  }}
                  aria-hidden="true"
                >
                  {getResultIcon(r)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      fontSize: '0.88rem',
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {highlightMatch(r.place_name, query)}
                  </div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-tertiary)',
                      marginTop: '0.1rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatSecondaryAddress(r)}
                  </div>
                </div>
              </li>
            ))
          ) : showNoResults ? (
            <li
              style={{
                padding: '1rem 0.75rem',
                textAlign: 'center',
                fontSize: '0.85rem',
                color: 'var(--text-tertiary)',
              }}
            >
              {t('web.address_no_results', { defaultValue: 'No se encontraron direcciones' })}
            </li>
          ) : null}
          {/* PR 4 of POI parity — TOS attribution for Google/Mapbox results */}
          {results.length > 0 && (() => {
            const hasGoogle = results.some(r => r.source === 'google');
            const hasMapbox = results.some(r => r.source === 'mapbox' || r.source === 'searchbox');
            const label = hasGoogle && hasMapbox
              ? 'Powered by Google + © Mapbox'
              : hasGoogle ? 'Powered by Google'
              : hasMapbox ? '© Mapbox'
              : null;
            if (!label) return null;
            return (
              <li style={{
                padding: '0.4rem 0.75rem',
                fontSize: '0.7rem',
                fontStyle: 'italic',
                color: 'var(--text-tertiary)',
                borderTop: '1px solid var(--border-subtle)',
              }}>{label}</li>
            );
          })()}
        </ul>
      )}

      {/* CSS spinner animation */}
      <style>{`
        @keyframes address-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
