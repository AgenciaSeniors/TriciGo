'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { haversineDistance, findIntersection, searchAddressSearchBox, searchPoisSupabase, computeSpecificity, stripAccents, fuzzyMatch } from '@tricigo/utils';
import type { SearchBoxResult } from '@tricigo/utils';

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Find all streets that cross a given main street, near a location */
async function suggestCrossStreets(
  mainStreet: string,
  proximity: { latitude: number; longitude: number },
): Promise<string[]> {
  const esc = (s: string) => s
    .replace(/[\\"/]/g, '')
    .replace(/[aáàâãä]/gi, '.')
    .replace(/[eéèêë]/gi, '.')
    .replace(/[iíìîï]/gi, '.')
    .replace(/[oóòôõö]/gi, '.')
    .replace(/[uúùûü]/gi, '.')
    .replace(/ñ/gi, '.');

  const mainEsc = esc(mainStreet);
  const { latitude: lat, longitude: lng } = proximity;
  // Find all highway ways near the main street, then get cross streets
  const query = `[out:json][timeout:3];way["name"~"${mainEsc}",i]["highway"](around:2000,${lat},${lng})->.main;way(around.main:5)["highway"]["name"];out tags;`;

  const encoded = encodeURIComponent(query);
  try {
    const res = await Promise.any(
      OVERPASS_MIRRORS.map(m => fetch(`${m}?data=${encoded}`).then(r => {
        if (!r.ok) throw new Error('fail');
        return r.json();
      }))
    );
    if (!res?.elements?.length) return [];
    const mainLower = mainStreet.toLowerCase();
    const names = res.elements
      .map((el: any) => el.tags?.name)
      .filter((n: string | undefined): n is string => !!n && !n.toLowerCase().includes(mainLower));
    return [...new Set(names as string[])].slice(0, 8);
  } catch {
    return [];
  }
}

interface AddressResult {
  address: string;
  latitude: number;
  longitude: number;
  place_name: string;
  category?: string;
  source?: 'searchbox' | 'nominatim' | 'overpass' | 'supabase';
  specificity?: number;
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
  proximity?: { latitude: number; longitude: number };
  enrichAddress?: (lat: number, lng: number) => Promise<string | null>;
}

function getSavedIcon(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('casa') || lower.includes('home')) return '🏠';
  if (lower.includes('trabajo') || lower.includes('work') || lower.includes('oficina')) return '🏢';
  if (lower.includes('gym') || lower.includes('gimnasio')) return '🏋️';
  if (lower.includes('escuela') || lower.includes('school') || lower.includes('universidad')) return '🎓';
  return '⭐';
}

interface CubanParsed {
  main: string;
  cross1: string;
  cross2?: string;
  partial?: 'waiting_cross1' | 'waiting_cross2'; // user still typing
}

function parseCubanAddress(query: string): CubanParsed | null {
  let m: RegExpMatchArray | null;

  // COMPLETE: "X entre Y y Z" or "X e/ Y y Z"
  m = query.match(/^(.+?)\s+entre\s+(.+?)\s+y\s+(.+)$/i);
  if (m) return { main: m[1].trim(), cross1: m[2].trim(), cross2: m[3].trim() };
  m = query.match(/^(.+?)\s+e\/\s*(.+?)\s+y\s+(.+)$/i);
  if (m) return { main: m[1].trim(), cross1: m[2].trim(), cross2: m[3].trim() };

  // PARTIAL: "X entre Y y " or "X e/ Y y " (user about to type cross2)
  m = query.match(/^(.+?)\s+entre\s+(.+?)\s+y\s*$/i);
  if (m) return { main: m[1].trim(), cross1: m[2].trim(), partial: 'waiting_cross2' };
  m = query.match(/^(.+?)\s+e\/\s*(.+?)\s+y\s*$/i);
  if (m) return { main: m[1].trim(), cross1: m[2].trim(), partial: 'waiting_cross2' };

  // PARTIAL: "X entre Y" (could be complete or user still typing)
  m = query.match(/^(.+?)\s+entre\s+(.+)$/i);
  if (m) return { main: m[1].trim(), cross1: m[2].trim() };

  // PARTIAL: "X entre " (user about to type cross1)
  m = query.match(/^(.+?)\s+entre\s*$/i);
  if (m) return { main: m[1].trim(), cross1: '', partial: 'waiting_cross1' };
  m = query.match(/^(.+?)\s+e\/\s*$/i);
  if (m) return { main: m[1].trim(), cross1: '', partial: 'waiting_cross1' };

  // NOTE: "X y Z" pattern removed — too many false positives
  // ("Capitolio Nacional" was detected as intersection)
  // For "23 y L", user should write "23 entre L" or use fallback

  return null;
}

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

/** Category-to-icon map for Search Box API categories */
const CATEGORY_ICONS: Record<string, string> = {
  hotel: '🏨', lodging: '🏨', hostel: '🏨',
  hospital: '🏥', clinic: '🏥', doctor: '🏥', pharmacy: '💊',
  university: '🎓', school: '🎓', college: '🎓', education: '🎓',
  park: '🌳', garden: '🌳', playground: '🌳', plaza: '🌳',
  restaurant: '🍽️', cafe: '🍽️', food: '🍽️', bar: '🍸',
  airport: '✈️', bus_station: '🚉', train_station: '🚉', transit: '🚉',
  museum: '🏛️', monument: '🏛️', historic: '🏛️',
  church: '⛪', place_of_worship: '⛪',
  supermarket: '🛒', shop: '🛒', market: '🛒', store: '🛒',
  bank: '🏦', atm: '🏦',
  gas_station: '⛽', fuel: '⛽',
  cinema: '🎬', theater: '🎭', theatre: '🎭',
  library: '📚', swimming_pool: '🏊', gym: '🏋️', sports: '⚽',
  embassy: '🏛️', government: '🏛️',
};

function getResultIcon(result: AddressResult): string {
  // First try category from API (most accurate)
  if (result.category) {
    const cat = result.category.toLowerCase();
    for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
      if (cat.includes(key)) return icon;
    }
  }
  // Fallback to name-based matching
  const name = (result.place_name + ' ' + result.address).toLowerCase();
  if (name.includes('hotel') || name.includes('hostal') || name.includes('casa particular')) return '🏨';
  if (name.includes('hospital') || name.includes('clínica') || name.includes('policlínico')) return '🏥';
  if (name.includes('universidad') || name.includes('escuela') || name.includes('instituto')) return '🎓';
  if (name.includes('parque') || name.includes('plaza')) return '🌳';
  if (name.includes('restaurante') || name.includes('paladar') || name.includes('cafetería')) return '🍽️';
  if (name.includes('aeropuerto') || name.includes('terminal')) return '✈️';
  if (name.includes('estación') || name.includes('terminal de')) return '🚉';
  if (name.includes('museo')) return '🏛️';
  if (name.includes('iglesia') || name.includes('catedral')) return '⛪';
  if (name.includes('mercado') || name.includes('tienda')) return '🛒';
  if (name.includes(' e/ ') || name.includes(' entre ')) return '🔀';
  return '📍';
}

/** Multi-factor relevance score for ranking search results */
function scoreResult(
  result: AddressResult,
  normalizedQuery: string,
  proximity?: { latitude: number; longitude: number } | null,
): number {
  const normalizedName = stripAccents(result.place_name.toLowerCase().trim());

  // Text match quality (40% weight)
  let textScore = 0.2;
  if (normalizedName === normalizedQuery) textScore = 1.0;
  else if (normalizedName.startsWith(normalizedQuery)) textScore = 0.85;
  else if (normalizedName.includes(normalizedQuery)) textScore = 0.65;
  else {
    // Check if query words are in the name
    const queryWords = normalizedQuery.split(/\s+/);
    const matchCount = queryWords.filter(w => normalizedName.includes(w)).length;
    textScore = 0.2 + (matchCount / queryWords.length) * 0.4;
  }

  // Specificity (30% weight) — named POIs rank higher than generic categories
  const specScore = result.specificity ?? computeSpecificity(result.place_name);

  // Distance (20% weight) — closer is better, normalized to 20km range
  let distScore = 0.5;
  if (proximity) {
    const dist = haversineDistance(
      { latitude: result.latitude, longitude: result.longitude },
      { latitude: proximity.latitude, longitude: proximity.longitude },
    );
    distScore = Math.max(0, 1 - dist / 20000);
  }

  // Source priority (10% weight)
  const sourceScore = result.source === 'searchbox' ? 1.0 : result.source === 'supabase' ? 0.9 : result.source === 'overpass' ? 0.8 : 0.5;

  return textScore * 0.4 + specScore * 0.3 + distScore * 0.2 + sourceScore * 0.1;
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

export function AddressAutocomplete({ label, placeholder, value, onSelect, onClear, mapboxToken, savedLocations, proximity, enrichAddress }: AddressAutocompleteProps) {
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
  const [recentAddresses, setRecentAddresses] = useState<AddressResult[]>([]);

  // Load recent addresses from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('tricigo_recent_addresses');
      if (stored) setRecentAddresses(JSON.parse(stored));
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

  async function searchNominatimEnhanced(q: string, prox?: { latitude: number; longitude: number }): Promise<AddressResult[]> {
    try {
      const viewbox = prox
        ? `${prox.longitude - 0.15},${prox.latitude - 0.15},${prox.longitude + 0.15},${prox.latitude + 0.15}`
        : '-82.6,22.9,-82.1,23.3'; // Havana metro area
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&countrycodes=cu&limit=8&viewbox=${viewbox}&bounded=1&addressdetails=1&namedetails=1&extratags=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
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
    }
  }

  // Search Box API fetch with caching
  const fetchSearchBox = useCallback(async (q: string, signal?: AbortSignal): Promise<AddressResult[]> => {
    const cached = mapboxCacheRef.current.get(q);
    if (cached) return cached;
    try {
      const results = await searchAddressSearchBox(q, proximity ?? null, signal, 10);
      const items: AddressResult[] = results.map(r => ({
        address: r.full_address || r.address,
        latitude: r.latitude,
        longitude: r.longitude,
        place_name: r.place_name,
        category: r.category,
        source: r.source,
        specificity: r.specificity,
      }));
      mapboxCacheRef.current.set(q, items);
      return items;
    } catch (err: any) {
      if (err?.name === 'AbortError') return [];
      return [];
    }
  }, [proximity]);

  const search = useCallback(async (q: string) => {
    if (q.length < 1) { setResults([]); setIsOpen(false); return; }

    const thisSearchId = ++searchIdRef.current; // Track this search
    setLoading(true);

    try {
      const cubanParsed = parseCubanAddress(q);

      // ─── PATH 1: PARTIAL CUBAN (user typing "Lindero e/ Clavel y ") ───
      if (cubanParsed?.partial && proximity) {
        const crossStreets = await suggestCrossStreets(cubanParsed.main, proximity);
        if (searchIdRef.current !== thisSearchId) return; // Stale — discard
        if (crossStreets.length > 0) {
          const suggestions: AddressResult[] = crossStreets.map(cs => {
            const addr = cubanParsed.partial === 'waiting_cross2'
              ? `${cubanParsed.main} e/ ${cubanParsed.cross1} y ${cs}`
              : `${cubanParsed.main} e/ ${cs}`;
            return { address: addr, latitude: proximity.latitude, longitude: proximity.longitude, place_name: addr };
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
        const intersection = await findIntersection(
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
        // Cuban search failed — fall through to Mapbox as backup
      }

      // ─── PATH 3: NORMAL SEARCH — Search Box + Supabase + Nominatim in parallel ───
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // All 3 sources in parallel (Supabase replaces Overpass — instant, any query)
      const [searchBoxSettled, supabaseSettled, nominatimSettled] = await Promise.allSettled([
        fetchSearchBox(q, controller.signal),
        searchPoisSupabase(q, proximity ?? null, 10).then(items =>
          items.map(r => ({
            address: r.full_address || r.address,
            latitude: r.latitude,
            longitude: r.longitude,
            place_name: r.place_name,
            category: r.category,
            source: 'supabase' as const,
            specificity: r.specificity,
          }))
        ),
        searchNominatimEnhanced(q, proximity),
      ]);
      if (searchIdRef.current !== thisSearchId) return;

      const searchBoxItems = searchBoxSettled.status === 'fulfilled' ? searchBoxSettled.value : [];
      const supabaseItems = supabaseSettled.status === 'fulfilled' ? supabaseSettled.value : [];
      const nominatimItems = nominatimSettled.status === 'fulfilled' ? nominatimSettled.value : [];

      // ─── SMART DEDUPLICATION ───
      // Combine all results, then deduplicate by name similarity + proximity
      const allItems: AddressResult[] = [
        ...searchBoxItems.map(r => ({ ...r, source: 'searchbox' as const, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
        ...supabaseItems.map(r => ({ ...r, source: 'supabase' as const, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
        ...nominatimItems.map(r => ({ ...r, source: 'nominatim' as const, specificity: r.specificity ?? computeSpecificity(r.place_name) })),
      ];

      // Filter out results too far from proximity (max 30km)
      const MAX_DISTANCE = 30000;
      const filtered = proximity
        ? allItems.filter(r => {
            const dist = haversineDistance(
              { latitude: r.latitude, longitude: r.longitude },
              { latitude: proximity.latitude, longitude: proximity.longitude },
            );
            return dist <= MAX_DISTANCE;
          })
        : allItems;

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
            const intersection = await findIntersection(yMatch[1].trim(), yMatch[2].trim(), undefined, proximity || undefined);
            if (searchIdRef.current !== thisSearchId) return;
            if (intersection) {
              merged = [{ address: intersection.address, latitude: intersection.latitude, longitude: intersection.longitude, place_name: intersection.address }];
            }
          } catch { /* ignore */ }
        }
      }

      // ─── MULTI-FACTOR RANKING ───
      if (merged.length > 1) {
        const normalizedQuery = stripAccents(q.toLowerCase().trim());
        merged.sort((a, b) => {
          const scoreA = scoreResult(a, normalizedQuery, proximity);
          const scoreB = scoreResult(b, normalizedQuery, proximity);
          return scoreB - scoreA; // Higher score first
        });
      }

      // Hard distance filter: remove anything > 30km from proximity (safety net)
      const prox = proximity || { latitude: 23.1136, longitude: -82.3666 }; // Default: Havana
      merged = merged.filter(r => {
        if (!r.latitude || !r.longitude) return false;
        const d = haversineDistance(
          { latitude: r.latitude, longitude: r.longitude },
          { latitude: prox.latitude, longitude: prox.longitude },
        );
        return d <= 30000;
      });

      const initial = merged.slice(0, 7);
      setResults(initial);
      setIsOpen(true);
      setActiveIndex(-1);

      // BACKGROUND: Enrich top 3 results with cross-streets
      if (enrichAddress && initial.length > 0) {
        const enrichPromises = initial.slice(0, 3).map(async (r, idx) => {
          try {
            const enriched = await enrichAddress(r.latitude, r.longitude);
            if (enriched && searchIdRef.current === thisSearchId) {
              return { idx, place_name: enriched, address: r.address, latitude: r.latitude, longitude: r.longitude };
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
      return;
    }
    debounceRef.current = setTimeout(() => search(val), 200);
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
    setQuery(result.place_name); // Show immediately
    setIsOpen(false);
    setActiveIndex(-1);

    // If this is a Cuban address suggestion, try to resolve exact intersection coords
    const parsed = parseCubanAddress(result.place_name);
    if (parsed && !parsed.partial && parsed.cross1 && proximity) {
      try {
        const intersection = await findIntersection(parsed.main, parsed.cross1, parsed.cross2, proximity);
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
          return;
        }
      } catch { /* fallback below */ }
    }

    // Enrich with cross-streets for non-Cuban addresses
    if (enrichAddress) {
      try {
        const enriched = await enrichAddress(result.latitude, result.longitude);
        if (enriched) {
          setQuery(enriched);
          const enrichedResult = { ...result, address: enriched, place_name: enriched };
          saveToRecent(enrichedResult);
          onSelect(enrichedResult);
          return;
        }
      } catch { /* fallback to original */ }
    }

    saveToRecent(result);
    onSelect(result);
  }

  function handleClear() {
    setQuery('');
    setResults([]);
    setIsOpen(false);
    setActiveIndex(-1);
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
        if (activeIndex >= 0) {
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
  const hasSavedToShow = query.length === 0 && ((savedLocations && savedLocations.length > 0) || recentAddresses.length > 0);
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
            if (query.length === 0 && ((savedLocations && savedLocations.length > 0) || recentAddresses.length > 0)) {
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
