import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, TextInput, Pressable, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import {
  searchAddressUnified,
  newSessionToken,
  searchPoisSupabase,
  haversineDistance,
  stripAccents,
  fuzzyMatch,
  lookupIntersectionPoint,
  reverseGeocode,
  parseCubanAddress,
  suggestCrossStreetsSupabase,
  rankSearchResults,
  searchResultCap,
  searchResultEmoji,
  SEARCH_DEBOUNCE_MS,
} from '@tricigo/utils';
import type { SearchBoxResult, CubanParsed } from '@tricigo/utils';
import { SourceAttribution, inferAttributionSource } from '@tricigo/ui';
import { getSupabaseClient } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';

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
  // PR 4 of POI parity — when external search (Google/Mapbox) contributes
  // results, render "Powered by Google" / "© Mapbox" at the bottom of the
  // dropdown per TOS. Null when the dropdown contains only local sources.
  const [attribution, setAttribution] = useState<'google' | 'mapbox' | 'mixed' | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef(0);
  const searchCacheRef = useRef<Map<string, SearchBoxResult[]>>(new Map());
  // PR C of POI parity — Google Places session token. Lazy-init on first
  // keystroke, reset on select / clear / empty input. Reused for every
  // keystroke + the Place Details lookup in one billable session.
  const sessionTokenRef = useRef<string | null>(null);
  const internalRef = useRef<TextInput>(null);
  const ref = externalRef ?? internalRef;

  // Theme-aware palette — mirrors the app's cubanDark tokens. Brand orange
  // (focus border, highlight, spinner) stays fixed.
  const isDark = useThemeStore((s) => s.resolvedScheme) === 'dark';
  const c = isDark
    ? {
        surface: '#11172A',
        elevated: '#18203A',
        pressed: '#1E2740',
        sectionBg: '#0E1322',
        text: '#F4F0EA',
        textSubtle: '#6B7F8F',
        textFaint: '#4A5A6B',
        border: 'rgba(244,240,234,0.10)',
        divider: 'rgba(244,240,234,0.06)',
      }
    : {
        surface: '#fff',
        elevated: '#f5f5f5',
        pressed: '#f5f5f5',
        sectionBg: '#fafafa',
        text: '#1a1a1a',
        textSubtle: '#9ca3af',
        textFaint: '#d1d5db',
        border: '#e5e5e5',
        divider: '#f0f0f0',
      };

  // Sync external value
  useEffect(() => {
    if (value !== undefined && value !== query) {
      setQuery(value);
      setSelected(!!value);
    }
  }, [value]);

  // Invalidate Mapbox cache when proximity changes
  useEffect(() => {
    searchCacheRef.current.clear();
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
        setAttribution(null);
        // Empty/short input ends the typeahead session.
        sessionTokenRef.current = null;
        return;
      }

      // Lazy-init the session token on the first non-empty keystroke.
      if (sessionTokenRef.current === null) {
        sessionTokenRef.current = newSessionToken();
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
              setAttribution(null);
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
            setAttribution(null);
            setShowDropdown(streets.length > 0);
            setLoading(false);
            return;
          }

          // PATH 3: Normal search — 3 sources in parallel
          // Use cuban.main as fallback query if intersection failed
          const searchQuery = (cuban && !cuban.partial && cuban.cross2) ? cuban.main : text;
          setCubanContext(null);
          setCrossStreets([]);

          // External provider cache — keyed by query. PR 4 of POI parity:
          // searchAddressUnified() tries Google Places first (best Cuban
          // coverage) and falls back to Mapbox SearchBox if Google is
          // unavailable or the daily budget cap is hit. The cache holds the
          // merged result so subsequent renders of the same query skip both
          // providers entirely.
          const cacheKey = searchQuery.toLowerCase().trim();
          let external: SearchBoxResult[];
          if (searchCacheRef.current.has(cacheKey)) {
            external = searchCacheRef.current.get(cacheKey)!;
          } else {
            const externalRes = await searchAddressUnified(searchQuery, getSupabaseClient(), proximity ?? null, controller.signal, 10, sessionTokenRef.current ?? undefined)
              .catch(() => [] as SearchBoxResult[]);
            if (searchIdRef.current !== thisId || controller.signal.aborted) { setLoading(false); return; }
            external = externalRes;
            searchCacheRef.current.set(cacheKey, external);
          }

          // Supabase + Nominatim in parallel (external may have been cached)
          const [supabaseRes, nominatimRes] = await Promise.allSettled([
            searchPoisSupabase(searchQuery, proximity ?? null, 10, controller.signal),
            searchNominatimEnhanced(searchQuery, proximity ?? null, controller.signal),
          ]);

          if (searchIdRef.current !== thisId || controller.signal.aborted) { setLoading(false); return; }

          const supabase = supabaseRes.status === 'fulfilled' ? supabaseRes.value : [];
          const nominatim = nominatimRes.status === 'fulfilled' ? nominatimRes.value : [];

          // Merge, dedup, rank
          const merged = [...external, ...supabase, ...nominatim];
          const deduped = deduplicateResults(merged);
          const scored = rankSearchResults(deduped, searchQuery, proximity ?? null)
            .slice(0, searchResultCap(searchQuery));

          setResults(scored);
          // PR 4 of POI parity — derive attribution from external sources
          // (Google/Mapbox). Local-only results clear the label.
          setAttribution(inferAttributionSource(scored));
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
      }, SEARCH_DEBOUNCE_MS);
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
    setAttribution(null);
    // Session ends on selection — drop the token so the next search opens
    // a fresh billable session.
    sessionTokenRef.current = null;
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
          sessionTokenRef.current = null;
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
    sessionTokenRef.current = null;
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
    setAttribution(null);
    sessionTokenRef.current = null;
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
          backgroundColor: c.surface,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: (showingDropdown || showingSaved) ? colors.brand.orange : c.border,
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
          placeholderTextColor={c.textSubtle}
          autoFocus={autoFocus}
          style={{
            flex: 1,
            fontSize: 14,
            color: c.text,
            outlineStyle: 'none',
            fontFamily: 'Montserrat, system-ui, sans-serif',
          } as any}
        />
        {loading && <ActivityIndicator size="small" color={colors.brand.orange} style={{ marginLeft: 8 }} />}
        {selected && !loading && (
          <Pressable onPress={handleClear} style={{ marginLeft: 8, padding: 4 }}>
            <Text style={{ fontSize: 16, color: c.textSubtle }}>✕</Text>
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
            backgroundColor: c.surface,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
            maxHeight: 300,
            shadowColor: '#000',
            shadowOpacity: isDark ? 0.5 : 0.12,
            shadowRadius: 12,
            elevation: 4,
            zIndex: 20,
            overflow: 'hidden',
          } as any}
        >
          <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.sectionBg }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: c.textSubtle, textTransform: 'uppercase' as any, letterSpacing: 0.5 }}>
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
                  backgroundColor: pressed || i === activeIndex ? c.pressed : c.surface,
                  borderBottomWidth: i < crossStreets.length - 1 ? 1 : 0,
                  borderBottomColor: c.divider,
                })}
              >
                <Text style={{ fontSize: 18, marginRight: 10 }}>🔀</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                    {cubanContext?.main} e/ {cubanContext?.cross1} y {street}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.textSubtle, marginTop: 1 }}>
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
            backgroundColor: c.surface,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
            maxHeight: 300,
            shadowColor: '#000',
            shadowOpacity: isDark ? 0.5 : 0.12,
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
                    backgroundColor: pressed || i === activeIndex ? c.pressed : c.surface,
                    borderBottomWidth: i < results.length - 1 ? 1 : 0,
                    borderBottomColor: c.divider,
                  })}
                >
                  <Text style={{ fontSize: 18, marginRight: 10 }}>{searchResultEmoji(r)}</Text>
                  <View style={{ flex: 1 }}>
                    {Platform.OS === 'web' ? (
                      <div style={{ fontSize: 13, fontWeight: 600, color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {renderHighlight(r.place_name || r.address)}
                      </div>
                    ) : (
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                        {r.place_name || r.address}
                      </Text>
                    )}
                    {secondary && (
                      <Text style={{ fontSize: 11, color: c.textSubtle, marginTop: 2 }} numberOfLines={1}>
                        {secondary}
                      </Text>
                    )}
                    {r.source === 'supabase' && (
                      <Text style={{ fontSize: 9, color: c.textFaint, marginTop: 1 }}>
                        Local
                      </Text>
                    )}
                  </View>
                </Pressable>
              );
            }) : (
              <View style={{ paddingHorizontal: 14, paddingVertical: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 13, color: c.textSubtle, textAlign: 'center' }}>
                  No encontramos resultados. Intenta con otro término.
                </Text>
              </View>
            )}
            {/* PR 4 of POI parity — TOS attribution for external providers */}
            {attribution && results.length > 0 && (
              <SourceAttribution source={attribution} isDark={isDark} />
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
            backgroundColor: c.surface,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: c.border,
            maxHeight: 300,
            shadowColor: '#000',
            shadowOpacity: isDark ? 0.5 : 0.12,
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
                <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.sectionBg }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.textSubtle, textTransform: 'uppercase' as any, letterSpacing: 0.5 }}>
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
                      backgroundColor: pressed ? c.pressed : c.surface,
                      borderBottomWidth: 1,
                      borderBottomColor: c.divider,
                    })}
                  >
                    <Text style={{ fontSize: 18, marginRight: 10 }}>{getSavedIcon(loc.label)}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                        {loc.label}
                      </Text>
                      <Text style={{ fontSize: 11, color: c.textSubtle, marginTop: 1 }} numberOfLines={1}>
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
                <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.sectionBg }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: c.textSubtle, textTransform: 'uppercase' as any, letterSpacing: 0.5 }}>
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
                      backgroundColor: pressed ? c.pressed : c.surface,
                      borderBottomWidth: i < recentAddresses.length - 1 ? 1 : 0,
                      borderBottomColor: c.divider,
                    })}
                  >
                    <Text style={{ fontSize: 18, marginRight: 10 }}>🕐</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '500', color: c.text }} numberOfLines={1}>
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
