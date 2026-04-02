import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, TextInput, Pressable, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import {
  searchAddressSearchBox,
  searchPoisSupabase,
  computeSpecificity,
  haversineDistance,
  stripAccents,
  fuzzyMatch,
  lookupIntersectionPoint,
  reverseGeocode,
  parseCubanAddress,
  suggestCrossStreetsSupabase,
} from '@tricigo/utils';
import type { SearchBoxResult, CubanParsed } from '@tricigo/utils';
import { colors } from '@tricigo/theme';

/* ─── Types ─── */

interface SelectResult {
  address: string;
  latitude: number;
  longitude: number;
}

interface SavedLocationItem {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface WebAddressInputProps {
  placeholder?: string;
  value?: string;
  onSelect: (result: SelectResult) => void;
  onClear?: () => void;
  onFocus?: () => void;
  proximity?: { latitude: number; longitude: number } | null;
  icon?: React.ReactNode;
  autoFocus?: boolean;
  inputRef?: React.RefObject<TextInput>;
  savedLocations?: SavedLocationItem[];
  recentAddresses?: SelectResult[];
  onAddRecent?: (addr: SelectResult) => void;
}

/* ─── Category Icons ─── */

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

function getIcon(category?: string): string {
  if (!category) return '📍';
  const cat = category.toLowerCase();
  for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
    if (cat.includes(key)) return icon;
  }
  return '📍';
}

function getSavedIcon(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes('casa') || lower.includes('home')) return '🏠';
  if (lower.includes('trabajo') || lower.includes('work') || lower.includes('oficina')) return '🏢';
  if (lower.includes('gym') || lower.includes('gimnasio')) return '🏋️';
  if (lower.includes('escuela') || lower.includes('school') || lower.includes('universidad')) return '🎓';
  return '⭐';
}

/* ─── parseCubanAddress + suggestCrossStreetsSupabase imported from @tricigo/utils ─── */

/* ─── Nominatim Search (Cuba) ─── */

async function searchNominatimEnhanced(
  query: string,
  _proximity: { latitude: number; longitude: number } | null,
  signal?: AbortSignal,
): Promise<SearchBoxResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    namedetails: '1',
    limit: '5',
    countrycodes: 'cu',
    viewbox: '-84.95,19.8,-74.13,23.3',
    bounded: '1',
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'Accept-Language': 'es', 'User-Agent': 'TriciGo/1.0' },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data as any[]).map((item) => ({
      address: item.display_name,
      latitude: parseFloat(item.lat),
      longitude: parseFloat(item.lon),
      place_name: item.namedetails?.name || item.display_name.split(',')[0],
      full_address: item.display_name,
      category: item.type || item.class,
      source: 'nominatim' as const,
      specificity: 0.5,
    }));
  } catch {
    return [];
  }
}

/* ─── Scoring & Dedup ─── */

function scoreResult(
  r: SearchBoxResult,
  query: string,
  proximity: { latitude: number; longitude: number } | null,
): number {
  const q = stripAccents(query.toLowerCase());
  const name = stripAccents((r.place_name || r.address || '').toLowerCase());

  // Text score (40%)
  let textScore = 0.3;
  if (name === q) textScore = 1.0;
  else if (name.startsWith(q)) textScore = 0.85;
  else if (name.includes(q)) textScore = 0.65;
  else {
    // Word-by-word fallback for multi-word queries ("Hospital Nacional")
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const matchCount = words.filter((w) => name.includes(w)).length;
      textScore = Math.max(textScore, 0.4 + (matchCount / words.length) * 0.3);
    }
  }

  // Specificity (30%)
  const specificity = r.specificity ?? computeSpecificity(r.place_name || r.address || '');

  // Distance (20%) — normalize to 20km
  let distScore = 0.5;
  if (proximity && r.latitude && r.longitude) {
    const dist = haversineDistance(
      { latitude: proximity.latitude, longitude: proximity.longitude },
      { latitude: r.latitude, longitude: r.longitude },
    );
    distScore = Math.max(0, 1 - dist / 20000);
  }

  // Source (10%)
  const sourceScores: Record<string, number> = { searchbox: 1.0, supabase: 0.9, nominatim: 0.5, overpass: 0.6 };
  const srcScore = sourceScores[r.source] ?? 0.5;

  return textScore * 0.4 + specificity * 0.3 + distScore * 0.2 + srcScore * 0.1;
}

function deduplicateResults(results: SearchBoxResult[]): SearchBoxResult[] {
  const deduped: SearchBoxResult[] = [];
  for (const r of results) {
    const dupIdx = deduped.findIndex((d) => {
      const dist = haversineDistance(
        { latitude: d.latitude, longitude: d.longitude },
        { latitude: r.latitude, longitude: r.longitude },
      );
      if (dist > 500) return false;
      const n1 = stripAccents((d.place_name || d.address || '').toLowerCase());
      const n2 = stripAccents((r.place_name || r.address || '').toLowerCase());
      // Use fuzzyMatch for better similarity detection
      return fuzzyMatch(n1, n2) || n1.includes(n2) || n2.includes(n1) || dist < 100;
    });
    if (dupIdx === -1) {
      deduped.push(r);
    } else {
      // Keep the one with higher specificity
      const existing = deduped[dupIdx];
      if (existing && (r.specificity ?? 0) > (existing.specificity ?? 0)) {
        deduped[dupIdx] = r;
      }
    }
  }
  return deduped;
}

/* ─── Formatting helpers ─── */

function formatSecondaryAddress(r: SearchBoxResult): string | null {
  if (!r.full_address || r.full_address === r.place_name) return null;
  const secondary = r.full_address
    .replace(r.place_name || '', '')
    .replace(/^[\s,]+/, '')
    .trim();
  return secondary || null;
}

/* ─── Component ─── */

export function WebAddressInput({
  placeholder = 'Buscar dirección...',
  value,
  onSelect,
  onClear,
  onFocus,
  proximity,
  icon,
  autoFocus,
  inputRef: externalRef,
  savedLocations,
  recentAddresses,
  onAddRecent,
}: WebAddressInputProps) {
  const [query, setQuery] = useState(value ?? '');
  const [results, setResults] = useState<SearchBoxResult[]>([]);
  const [crossStreets, setCrossStreets] = useState<string[]>([]);
  const [cubanContext, setCubanContext] = useState<CubanParsed | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selected, setSelected] = useState(!!value);
  const [showSaved, setShowSaved] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef(0);
  const mapboxCacheRef = useRef<Map<string, SearchBoxResult[]>>(new Map());
  const internalRef = useRef<TextInput>(null);
  const ref = externalRef ?? internalRef;

  // Sync external value
  useEffect(() => {
    if (value !== undefined && value !== query) {
      setQuery(value);
      setSelected(!!value);
    }
  }, [value]);

  // Invalidate Mapbox cache when proximity changes
  useEffect(() => {
    mapboxCacheRef.current.clear();
  }, [proximity?.latitude, proximity?.longitude]);

  // Reset activeIndex when results change
  useEffect(() => {
    setActiveIndex(-1);
  }, [results, crossStreets]);

  // Keyboard navigation (web only)
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = (ref.current as any)?._node || (ref.current as any);
    if (!el?.addEventListener) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (e: any) => {
      const totalItems = crossStreets.length > 0 ? crossStreets.length : results.length;
      if (!totalItems && !showSaved) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i: number) => Math.min(i + 1, totalItems - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i: number) => Math.max(i - 1, -1));
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        if (crossStreets.length > 0 && cubanContext) {
          const street = crossStreets[activeIndex];
          if (street) handleSelectCrossStreet(street);
        } else if (results[activeIndex]) {
          handleSelect(results[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        setShowDropdown(false);
        setShowSaved(false);
        setCrossStreets([]);
      }
    };

    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [results, crossStreets, activeIndex, cubanContext, showSaved]);

  const hasSavedOrRecent = (savedLocations?.length ?? 0) > 0 || (recentAddresses?.length ?? 0) > 0;

  // Show "no results" state
  const showNoResults = query.length >= 8 && !loading && results.length === 0 && crossStreets.length === 0 && showDropdown;

  const search = useCallback(
    (text: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();

      if (text.length < 2) {
        setResults([]);
        setCrossStreets([]);
        setCubanContext(null);
        setShowDropdown(false);
        setShowSaved(false);
        return;
      }

      setShowSaved(false);
      const thisId = ++searchIdRef.current;

      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          // Check for Cuban address pattern
          const cuban = parseCubanAddress(text);

          if (cuban && !cuban.partial && cuban.cross1 && cuban.cross2) {
            // PATH 1: Complete Cuban address → resolve intersection via Supabase (~5ms)
            setCubanContext(null);
            setCrossStreets([]);
            const intersection = await lookupIntersectionPoint(
              cuban.main,
              cuban.cross1,
              cuban.cross2,
              proximity ?? undefined,
            );
            if (searchIdRef.current !== thisId || controller.signal.aborted) { setLoading(false); return; }

            if (intersection) {
              const r: SearchBoxResult = {
                address: intersection.address,
                latitude: intersection.latitude,
                longitude: intersection.longitude,
                place_name: `${cuban.main} e/ ${cuban.cross1} y ${cuban.cross2}`,
                full_address: intersection.address,
                source: 'overpass',
                specificity: 1.0,
              };
              setResults([r]);
              setCrossStreets([]);
              setShowDropdown(true);
              setLoading(false);
              return;
            }
            // Fallback: intersection not found → search main street name normally
            setCubanContext(null);
            // Fall through to PATH 3 below with main street as search query
          }

          if (cuban && cuban.partial) {
            // PATH 2: Partial Cuban address → suggest cross-streets via Supabase (~5ms)
            setCubanContext(cuban);
            const prox = proximity ? { latitude: proximity.latitude, longitude: proximity.longitude } : undefined;
            const streets = await suggestCrossStreetsSupabase(cuban.main, prox);
            if (searchIdRef.current !== thisId || controller.signal.aborted) { setLoading(false); return; }

            setCrossStreets(streets);
            setResults([]);
            setShowDropdown(streets.length > 0);
            setLoading(false);
            return;
          }

          // PATH 3: Normal search — 3 sources in parallel
          // Use cuban.main as fallback query if intersection failed
          const searchQuery = (cuban && !cuban.partial && cuban.cross2) ? cuban.main : text;
          setCubanContext(null);
          setCrossStreets([]);

          // Check Mapbox cache
          const cacheKey = searchQuery.toLowerCase().trim();
          let mapbox: SearchBoxResult[];
          if (mapboxCacheRef.current.has(cacheKey)) {
            mapbox = mapboxCacheRef.current.get(cacheKey)!;
          } else {
            const mapboxRes = await searchAddressSearchBox(searchQuery, proximity ?? null, controller.signal, 10)
              .catch(() => [] as SearchBoxResult[]);
            if (searchIdRef.current !== thisId || controller.signal.aborted) { setLoading(false); return; }
            mapbox = mapboxRes;
            mapboxCacheRef.current.set(cacheKey, mapbox);
          }

          // Supabase + Nominatim in parallel (Mapbox may have been cached)
          const [supabaseRes, nominatimRes] = await Promise.allSettled([
            searchPoisSupabase(searchQuery, proximity ?? null, 10, controller.signal),
            searchNominatimEnhanced(searchQuery, proximity ?? null, controller.signal),
          ]);

          if (searchIdRef.current !== thisId || controller.signal.aborted) { setLoading(false); return; }

          const supabase = supabaseRes.status === 'fulfilled' ? supabaseRes.value : [];
          const nominatim = nominatimRes.status === 'fulfilled' ? nominatimRes.value : [];

          // Merge, dedup, rank
          const merged = [...mapbox, ...supabase, ...nominatim];
          const deduped = deduplicateResults(merged);
          const scored = deduped
            .map((r) => ({ ...r, _score: scoreResult(r, searchQuery, proximity ?? null) }))
            .sort((a, b) => (b as any)._score - (a as any)._score)
            .slice(0, 7);

          setResults(scored);
          setShowDropdown(scored.length > 0 || searchQuery.length >= 8);
          setLoading(false);

          // Background enrichment (fire-and-forget): reverse geocode top 3
          // Only update if enriched address has cross-streets (more specific).
          if (scored.length > 0) {
            const enrichThisId = thisId;
            scored.slice(0, 3).forEach(async (r, idx) => {
              try {
                const enriched = await reverseGeocode(r.latitude, r.longitude);
                if (enriched && searchIdRef.current === enrichThisId) {
                  // Only overwrite if enriched is MORE specific (has cross-streets)
                  const hasCrossStreets = enriched.includes(' e/ ') || enriched.includes(' entre ');
                  if (hasCrossStreets) {
                    setResults((prev) =>
                      prev.map((p, i) => (i === idx ? { ...p, full_address: enriched } : p)),
                    );
                  }
                }
              } catch {
                /* silent */
              }
            });
          }
        } catch {
          if (searchIdRef.current === thisId) {
            setLoading(false);
          }
        }
      }, 250);
    },
    [proximity],
  );

  const handleChange = (text: string) => {
    setQuery(text);
    setSelected(false);
    setShowSaved(false);
    setCrossStreets([]);
    setCubanContext(null);
    if (text.length === 0 && hasSavedOrRecent) {
      setShowDropdown(false);
      setShowSaved(true);
    } else {
      search(text);
    }
  };

  const handleSelect = (result: SearchBoxResult) => {
    const addr: SelectResult = {
      address: result.place_name || result.address,
      latitude: result.latitude,
      longitude: result.longitude,
    };
    setQuery(result.place_name || result.address);
    setSelected(true);
    setShowDropdown(false);
    setShowSaved(false);
    setResults([]);
    setCrossStreets([]);
    setCubanContext(null);
    onAddRecent?.(addr);
    onSelect(addr);
  };

  const handleSelectCrossStreet = (streetName: string) => {
    if (!cubanContext) return;
    // Build the full Cuban address and resolve it
    const fullQuery = `${cubanContext.main} e/ ${cubanContext.cross1} y ${streetName}`;
    setQuery(fullQuery);
    setCrossStreets([]);
    setCubanContext(null);
    setLoading(true);

    const thisId = ++searchIdRef.current;
    (async () => {
      try {
        const intersection = await lookupIntersectionPoint(
          cubanContext.main,
          cubanContext.cross1,
          streetName,
          proximity ?? undefined,
        );
        if (searchIdRef.current !== thisId) return;

        if (intersection) {
          const addr: SelectResult = {
            address: intersection.address || fullQuery,
            latitude: intersection.latitude,
            longitude: intersection.longitude,
          };
          setQuery(fullQuery);
          setSelected(true);
          setShowDropdown(false);
          setResults([]);
          onAddRecent?.(addr);
          onSelect(addr);
        } else {
          // Fallback: search normally
          setLoading(false);
          search(fullQuery);
        }
      } catch {
        setLoading(false);
        search(fullQuery);
      }
    })();
  };

  const handleSelectSaved = (item: SavedLocationItem | SelectResult) => {
    const addr: SelectResult = {
      address: 'label' in item ? item.label : item.address,
      latitude: item.latitude,
      longitude: item.longitude,
    };
    setQuery(addr.address);
    setSelected(true);
    setShowDropdown(false);
    setShowSaved(false);
    setResults([]);
    setCrossStreets([]);
    onSelect(addr);
  };

  const handleClear = () => {
    setQuery('');
    setSelected(false);
    setResults([]);
    setCrossStreets([]);
    setCubanContext(null);
    setShowDropdown(false);
    setShowSaved(false);
    onClear?.();
    ref.current?.focus();
  };

  const handleFocus = () => {
    onFocus?.();
    if (!selected && query.length === 0 && hasSavedOrRecent) {
      setShowSaved(true);
    } else if (results.length > 0 && !selected) {
      setShowDropdown(true);
    } else if (crossStreets.length > 0) {
      setShowDropdown(true);
    }
  };

  const showingDropdown = showDropdown && (results.length > 0 || crossStreets.length > 0 || showNoResults);
  const showingSaved = showSaved && !showDropdown && hasSavedOrRecent;

  /* ─── Highlight matching text ─── */
  const renderHighlight = (text: string): React.ReactNode => {
    if (!query || query.length < 1 || Platform.OS !== 'web') return text;
    const normalizedText = stripAccents(text.toLowerCase());
    const normalizedQuery = stripAccents(query.toLowerCase());
    const idx = normalizedText.indexOf(normalizedQuery);
    if (idx === -1) return text;
    // Use dangerouslySetInnerHTML-free approach with spans
    return (
      <span>
        {text.slice(0, idx)}
        <span style={{ color: colors.brand.orange, fontWeight: 700 }}>
          {text.slice(idx, idx + query.length)}
        </span>
        {text.slice(idx + query.length)}
      </span>
    ) as any;
  };

  return (
    <View style={{ position: 'relative', zIndex: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: '#fff',
          borderRadius: 10,
          borderWidth: 1,
          borderColor: (showingDropdown || showingSaved) ? colors.brand.orange : '#e5e5e5',
          paddingHorizontal: 12,
          height: 46,
        }}
      >
        {icon && <View style={{ marginRight: 10 }}>{icon}</View>}
        <TextInput
          ref={ref as any}
          value={query}
          onChangeText={handleChange}
          onFocus={handleFocus}
          onBlur={() => {
            setTimeout(() => {
              setShowDropdown(false);
              setShowSaved(false);
              setCrossStreets([]);
            }, 200);
          }}
          placeholder={placeholder}
          placeholderTextColor="#9ca3af"
          autoFocus={autoFocus}
          style={{
            flex: 1,
            fontSize: 14,
            color: '#1a1a1a',
            outlineStyle: 'none',
            fontFamily: 'Montserrat, system-ui, sans-serif',
          } as any}
        />
        {loading && <ActivityIndicator size="small" color={colors.brand.orange} style={{ marginLeft: 8 }} />}
        {selected && !loading && (
          <Pressable onPress={handleClear} style={{ marginLeft: 8, padding: 4 }}>
            <Text style={{ fontSize: 16, color: '#9ca3af' }}>✕</Text>
          </Pressable>
        )}
      </View>

      {/* Cross-street suggestions dropdown */}
      {showingDropdown && crossStreets.length > 0 && (
        <View
          style={{
            position: 'absolute',
            top: 50,
            left: 0,
            right: 0,
            backgroundColor: '#fff',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#e5e5e5',
            maxHeight: 300,
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 12,
            elevation: 4,
            zIndex: 20,
            overflow: 'hidden',
          } as any}
        >
          <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fafafa' }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase' as any, letterSpacing: 0.5 }}>
              Calles que cruzan {cubanContext?.main}
            </Text>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {crossStreets.map((street, i) => (
              <Pressable
                key={`cross-${i}`}
                onPress={() => handleSelectCrossStreet(street)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 14,
                  paddingVertical: 11,
                  backgroundColor: pressed || i === activeIndex ? '#f5f5f5' : '#fff',
                  borderBottomWidth: i < crossStreets.length - 1 ? 1 : 0,
                  borderBottomColor: '#f0f0f0',
                })}
              >
                <Text style={{ fontSize: 18, marginRight: 10 }}>🔀</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1a1a' }} numberOfLines={1}>
                    {cubanContext?.main} e/ {cubanContext?.cross1} y {street}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>
                    {street}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Search results dropdown */}
      {showingDropdown && crossStreets.length === 0 && (results.length > 0 || showNoResults) && (
        <View
          style={{
            position: 'absolute',
            top: 50,
            left: 0,
            right: 0,
            backgroundColor: '#fff',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#e5e5e5',
            maxHeight: 300,
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 12,
            elevation: 4,
            zIndex: 20,
            overflow: 'hidden',
          } as any}
        >
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {results.length > 0 ? results.map((r, i) => {
              const secondary = formatSecondaryAddress(r);
              return (
                <Pressable
                  key={`${r.latitude}-${r.longitude}-${i}`}
                  onPress={() => handleSelect(r)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 11,
                    backgroundColor: pressed || i === activeIndex ? '#f5f5f5' : '#fff',
                    borderBottomWidth: i < results.length - 1 ? 1 : 0,
                    borderBottomColor: '#f0f0f0',
                  })}
                >
                  <Text style={{ fontSize: 18, marginRight: 10 }}>{getIcon(r.category)}</Text>
                  <View style={{ flex: 1 }}>
                    {Platform.OS === 'web' ? (
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {renderHighlight(r.place_name || r.address)}
                      </div>
                    ) : (
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1a1a' }} numberOfLines={1}>
                        {r.place_name || r.address}
                      </Text>
                    )}
                    {secondary && (
                      <Text style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }} numberOfLines={1}>
                        {secondary}
                      </Text>
                    )}
                    {r.source === 'supabase' && (
                      <Text style={{ fontSize: 9, color: '#d1d5db', marginTop: 1 }}>
                        Local
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            }) : (
              <View style={{ paddingHorizontal: 14, paddingVertical: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>
                  No encontramos resultados. Intenta con otro término.
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      )}

      {/* Saved locations + recent addresses dropdown */}
      {showingSaved && (
        <View
          style={{
            position: 'absolute',
            top: 50,
            left: 0,
            right: 0,
            backgroundColor: '#fff',
            borderRadius: 10,
            borderWidth: 1,
            borderColor: '#e5e5e5',
            maxHeight: 300,
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 12,
            elevation: 4,
            zIndex: 20,
            overflow: 'hidden',
          } as any}
        >
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {/* Saved locations */}
            {savedLocations && savedLocations.length > 0 && (
              <>
                <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fafafa' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase' as any, letterSpacing: 0.5 }}>
                    Guardados
                  </Text>
                </View>
                {savedLocations.map((loc, i) => (
                  <Pressable
                    key={`saved-${i}`}
                    onPress={() => handleSelectSaved(loc)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 14,
                      paddingVertical: 11,
                      backgroundColor: pressed ? '#f5f5f5' : '#fff',
                      borderBottomWidth: 1,
                      borderBottomColor: '#f0f0f0',
                    })}
                  >
                    <Text style={{ fontSize: 18, marginRight: 10 }}>{getSavedIcon(loc.label)}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a1a1a' }} numberOfLines={1}>
                        {loc.label}
                      </Text>
                      <Text style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }} numberOfLines={1}>
                        {loc.address}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </>
            )}

            {/* Recent addresses */}
            {recentAddresses && recentAddresses.length > 0 && (
              <>
                <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fafafa' }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: '#9ca3af', textTransform: 'uppercase' as any, letterSpacing: 0.5 }}>
                    Recientes
                  </Text>
                </View>
                {recentAddresses.map((addr, i) => (
                  <Pressable
                    key={`recent-${i}`}
                    onPress={() => handleSelectSaved(addr)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 14,
                      paddingVertical: 11,
                      backgroundColor: pressed ? '#f5f5f5' : '#fff',
                      borderBottomWidth: i < recentAddresses.length - 1 ? 1 : 0,
                      borderBottomColor: '#f0f0f0',
                    })}
                  >
                    <Text style={{ fontSize: 18, marginRight: 10 }}>🕐</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '500', color: '#1a1a1a' }} numberOfLines={1}>
                        {addr.address}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
