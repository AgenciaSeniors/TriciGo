'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { haversineDistance, findIntersection } from '@tricigo/utils';

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
    return [...new Set(names)].slice(0, 8);
  } catch {
    return [];
  }
}

interface AddressResult {
  address: string;
  latitude: number;
  longitude: number;
  place_name: string;
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

  async function searchNominatim(q: string, prox?: { latitude: number; longitude: number }): Promise<AddressResult[]> {
    try {
      const viewbox = prox
        ? `${prox.longitude - 0.15},${prox.latitude - 0.15},${prox.longitude + 0.15},${prox.latitude + 0.15}`
        : '-82.6,22.9,-82.1,23.3'; // Havana metro area
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&countrycodes=cu&limit=5&viewbox=${viewbox}&bounded=1&addressdetails=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((item: any) => ({
        address: item.display_name || '',
        latitude: parseFloat(item.lat),
        longitude: parseFloat(item.lon),
        place_name: item.name || item.display_name?.split(',')[0] || '',
      }));
    } catch {
      return [];
    }
  }

  // Extract Mapbox fetch into a named function for reuse
  const fetchMapbox = useCallback(async (q: string, signal?: AbortSignal): Promise<AddressResult[]> => {
    // Check cache
    const cached = mapboxCacheRef.current.get(q);
    if (cached) return cached;

    try {
      let mapboxUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&country=cu&language=es&limit=5&types=address,poi,place,neighborhood,locality`;
      if (proximity) {
        mapboxUrl += `&proximity=${proximity.longitude},${proximity.latitude}`;
      }
      const res = await fetch(mapboxUrl, signal ? { signal } : undefined);
      if (!res.ok) return [];
      const data = await res.json();
      const items: AddressResult[] = [];
      for (const f of (data.features || [])) {
        const context = f.context || [];
        const neighborhood = context.find((c: any) => c.id?.startsWith('neighborhood'))?.text;
        const locality = context.find((c: any) => c.id?.startsWith('locality'))?.text;
        const place = context.find((c: any) => c.id?.startsWith('place'))?.text;
        const area = neighborhood || locality || place || '';
        const streetPart = f.text || '';
        const displayAddress = area && area !== streetPart
          ? `${streetPart}, ${area}`
          : f.place_name;
        items.push({
          address: f.place_name,
          latitude: f.center[1],
          longitude: f.center[0],
          place_name: displayAddress,
        });
      }
      // Cache result
      mapboxCacheRef.current.set(q, items);
      return items;
    } catch (err: any) {
      if (err?.name === 'AbortError') return [];
      return [];
    }
  }, [mapboxToken, proximity]);

  const search = useCallback(async (q: string) => {
    if (q.length < 3) { setResults([]); setIsOpen(false); return; }

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

      // ─── PATH 3: NORMAL SEARCH — Mapbox + Nominatim in parallel ───
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Run BOTH in parallel — Nominatim has better Cuba POI coverage
      const [mapboxSettled, nominatimSettled] = await Promise.allSettled([
        fetchMapbox(q, controller.signal),
        searchNominatim(q, proximity),
      ]);
      if (searchIdRef.current !== thisSearchId) return;

      const mapboxItems = mapboxSettled.status === 'fulfilled' ? mapboxSettled.value : [];
      const nominatimItems = nominatimSettled.status === 'fulfilled' ? nominatimSettled.value : [];

      // Merge: Nominatim first (better for Cuba POIs), then Mapbox (dedup by proximity)
      let merged = [...nominatimItems];
      for (const m of mapboxItems) {
        const isDuplicate = merged.some(existing =>
          haversineDistance(
            { latitude: existing.latitude, longitude: existing.longitude },
            { latitude: m.latitude, longitude: m.longitude },
          ) < 100
        );
        if (!isDuplicate) merged.push(m);
      }

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

      // Sort by distance to proximity
      if (proximity && merged.length > 1) {
        merged.sort((a, b) => {
          const distA = haversineDistance(
            { latitude: a.latitude, longitude: a.longitude },
            { latitude: proximity.latitude, longitude: proximity.longitude },
          );
          const distB = haversineDistance(
            { latitude: b.latitude, longitude: b.longitude },
            { latitude: proximity.latitude, longitude: proximity.longitude },
          );
          return distA - distB;
        });
      }

      const initial = merged.slice(0, 5);
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
  }, [mapboxToken, proximity, fetchMapbox, enrichAddress]);

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
          onSelect({
            address: intersection.address,
            latitude: intersection.latitude,
            longitude: intersection.longitude,
            place_name: intersection.address,
          });
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
          onSelect({ ...result, address: enriched, place_name: enriched });
          return;
        }
      } catch { /* fallback to original */ }
    }

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
        if (activeIndex >= 0 && activeIndex < results.length) {
          handleSelect(results[activeIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  const showNoResults = query.length >= 5 && !loading && results.length === 0 && isOpen;
  const hasSavedToShow = query.length === 0 && savedLocations && savedLocations.length > 0;
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
            if (query.length === 0 && savedLocations && savedLocations.length > 0) {
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
          {query.length === 0 && savedLocations && savedLocations.length > 0 ? (
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
          ) : results.length > 0 ? (
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
                  📍
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
                    {r.place_name}
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
                    {r.address}
                  </div>
                </div>
              </li>
            ))
          ) : (
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
          )}
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
