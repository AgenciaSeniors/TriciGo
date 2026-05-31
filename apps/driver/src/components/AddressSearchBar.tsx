import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  TextInput,
  Pressable,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Text } from '@tricigo/ui/Text';
import { colors } from '@tricigo/theme';
import {
  searchPoisSupabase,
  searchStreetsSupabase,
  searchAddress,
  searchAddressUnified,
  newSessionToken,
  tricigoCategoryEmoji,
  importPoiFromSearch,
  dedupeSearchResults,
  SEARCH_DEBOUNCE_MS,
  type GeoPoint,
  type SearchBoxResult,
} from '@tricigo/utils';
import { SourceAttribution, inferAttributionSource } from '@tricigo/ui';
import { getSupabaseClient } from '@tricigo/api';

interface AddressResult {
  id: string;
  /** Top line of the result (POI name when available, otherwise the street). */
  title: string;
  /** Bottom line — the street address when title is a POI name; empty otherwise. */
  subtitle: string;
  /** What we hand back to onSelect — combined "POI, street" or just street. */
  address: string;
  latitude: number;
  longitude: number;
  /** True for POI rows (so we render an icon + don't dedup against streets). */
  isPoi: boolean;
  /** Category emoji (POI rows from search_pois_smart only). */
  emoji?: string;
  /** PR 4b: original SearchBoxResult for background importPoiFromSearch.
   *  Only populated when the row came from `searchAddressUnified` (Google
   *  in particular). Supabase rows are already in cuba_pois, Mapbox rows
   *  bypass the import (importPoiFromSearch skips both). */
  _src?: SearchBoxResult;
}

interface AddressSearchBarProps {
  /** Called when the user selects a result — parent should move camera there */
  onSelect: (result: { latitude: number; longitude: number; address: string }) => void;
  placeholder?: string;
}

/**
 * Search the same Supabase POI + street cascade as the rider client.
 *
 * Order:
 *   1. Supabase cuba_pois (high-specificity POI matches first)
 *   2. Supabase street_intersections (cross-streets, "Calle 23 e/ M y N")
 *   3. Supabase cuba_pois (low-specificity / generic matches)
 *   4. Mapbox Search Box fallback when everything above is empty
 *
 * Driver searches usually mean "I need to navigate to this address" so the
 * full Cuban cross-street format is what we want — the rider client already
 * uses this same cascade.
 */
interface SearchOutcome {
  results: AddressResult[];
  /** When external providers (Google/Mapbox) contributed, surface attribution. */
  attribution: 'google' | 'mapbox' | 'mixed' | null;
}

async function searchUnified(query: string, near: GeoPoint | null, sessionToken: string | null, signal?: AbortSignal): Promise<SearchOutcome> {
  if (query.trim().length < 2) return { results: [], attribution: null };
  // Short-circuit if caller already aborted before we even fire requests
  if (signal?.aborted) return { results: [], attribution: null };

  // PR F (2026-05-25) — flipped search order: Google PRIMARY, cuba_pois
  // SECONDARY. Same change as the client AddressSearchInput — see the
  // comment there for the airport-bug rationale.
  //
  // T1.7 (2026-05-27) — pass AbortSignal to searchAddressUnified so the
  // Google EF call gets cancelled when the user types another character
  // before this debounced one resolves. Saves a Google billable session.
  const [unified, poiResults] = await Promise.all([
    searchAddressUnified(query, getSupabaseClient(), near, signal, 10, sessionToken ?? undefined).catch(() => [] as SearchBoxResult[]),
    searchPoisSupabase(query, near, 6).catch(() => [] as SearchBoxResult[]),
  ]);
  if (signal?.aborted) return { results: [], attribution: null };
  const detectedCategory = poiResults.find(r => r.matchedCategory)?.matchedCategory ?? null;
  const streetResults: SearchBoxResult[] = detectedCategory
    ? []
    : await searchStreetsSupabase(query, near, 5).catch(() => [] as SearchBoxResult[]);

  const toResult = (r: SearchBoxResult, idx: number): AddressResult => {
    const isPoi = !!(r.place_name && r.place_name !== r.address);
    return {
      id: `${r.source}-${r.latitude}-${r.longitude}-${idx}`,
      title: isPoi ? r.place_name : r.address,
      subtitle: isPoi ? r.address : '',
      address: isPoi && r.full_address ? `${r.place_name}, ${r.full_address}` : r.address,
      latitude: r.latitude,
      longitude: r.longitude,
      isPoi,
      emoji: isPoi ? tricigoCategoryEmoji(r.tricigoCategory) : undefined,
    };
  };

  // Dedupe cuba_pois rows against external results (coord ≤100 m OR
  // name token overlap ≥0.7). Keep smart-RPC ordering within survivors.
  const dedupedPois = dedupeSearchResults(unified, poiResults);
  const highSpecPois = dedupedPois.filter(r => r.specificity >= 0.8).map(toResult);
  const lowSpecPois  = dedupedPois.filter(r => r.specificity <  0.8).map(toResult);
  const streets      = streetResults.map(toResult);

  // PR 4b: attach _src so handleSelect can fire-and-forget the
  // import-mapbox-poi EF on Google selections.
  const externalNormalized = unified.map((r, idx) => ({ ...toResult(r, idx), _src: r }));

  // Final order: Google/Mapbox first → high-spec cuba_pois → streets →
  // low-spec cuba_pois. Cap at 8 (existing UX bound).
  const merged = [
    ...externalNormalized,
    ...highSpecPois,
    ...streets,
    ...lowSpecPois,
  ];
  if (merged.length > 0) {
    return {
      results: merged.slice(0, 8),
      attribution: inferAttributionSource(unified),
    };
  }

  // Last-resort fallback: Nominatim via searchAddress (free, slower).
  const fallback = await searchAddress(query, 6, near).catch(() => []);
  return {
    results: fallback.map((r, idx) => ({
      id: `mapbox-${idx}`,
      title: r.displayName || r.address,
      subtitle: r.address && r.address !== (r.displayName || r.address) ? r.address : '',
      address: r.address,
      latitude: r.latitude,
      longitude: r.longitude,
      isPoi: !!(r.displayName && r.displayName !== r.address),
    })),
    attribution: null,
  };
}

export function AddressSearchBar({ onSelect, placeholder = 'Buscar dirección...' }: AddressSearchBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [attribution, setAttribution] = useState<'google' | 'mapbox' | 'mixed' | null>(null);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [near, setNear] = useState<GeoPoint | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef<string>('');
  const inputRef = useRef<TextInput>(null);
  // PR C of POI parity — Google Places session token. Generated lazily on
  // the first keystroke of a typeahead session and reused for every
  // subsequent keystroke until the user selects, clears, or empties the
  // input. See `newSessionToken` for billing rationale.
  const sessionTokenRef = useRef<string | null>(null);
  // T1.7 (2026-05-27) — cancel in-flight fetches when the user types
  // another character or unmounts. Saves Google billable session +
  // prevents stale responses sneaking through after `lastQueryRef` check.
  const abortRef = useRef<AbortController | null>(null);
  // T1.7 — in-memory cache for repeated queries within the same session
  // (e.g. user types "Otra" → "Otramanera" → deletes → retypes "Otramanera"
  // → cache hit, no Google call). Capped at 50 entries to prevent leak;
  // cleared when `near` (driver location) changes since results are
  // proximity-biased and stale coords would mislead.
  const queryCacheRef = useRef<Map<string, SearchOutcome>>(new Map());
  // T1.7 — flag flips after the first search completes. Used to gate the
  // "No se encontraron lugares cerca" empty state so it doesn't flash
  // before the first call even fires.
  const hasSearchedRef = useRef(false);

  // Bias search results to the driver's current vicinity so closer
  // matches outrank far-away ones with similar names.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getLastKnownPositionAsync();
        if (!cancelled && pos) {
          setNear({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // T1.7 — invalidate cache when driver location changes. The cached
  // results are proximity-biased; keeping them after a meaningful move
  // would show stale "near you" rankings.
  useEffect(() => {
    queryCacheRef.current.clear();
  }, [near?.latitude, near?.longitude]);

  // T1.7 — cleanup on unmount: cancel pending debounce + in-flight fetch.
  // Prevents memory leaks and dangling Google calls when the driver
  // navigates out of the search screen mid-typing.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const handleChangeText = useCallback((text: string) => {
    setQuery(text);
    lastQueryRef.current = text;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // T1.7 — cancel any in-flight fetch from the previous keystroke
    abortRef.current?.abort();
    abortRef.current = null;
    if (!text.trim()) {
      setResults([]);
      setAttribution(null);
      setLoading(false);
      hasSearchedRef.current = false;
      // Empty input ends the typeahead session — drop the token so the
      // next keystroke starts a fresh billable session.
      sessionTokenRef.current = null;
      return;
    }
    // Lazy-init the session token on the first non-empty keystroke.
    if (sessionTokenRef.current === null) {
      sessionTokenRef.current = newSessionToken();
    }

    // T1.7 — in-memory cache check: if we already searched this exact
    // query (normalized) since the last `near` change, reuse the result
    // and skip the EF call entirely. Saves a Google billable session.
    const cacheKey = text.trim().toLowerCase();
    const cached = queryCacheRef.current.get(cacheKey);
    if (cached) {
      setResults(cached.results);
      setAttribution(cached.attribution);
      setLoading(false);
      hasSearchedRef.current = true;
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      // Fresh abort controller for THIS debounced fetch
      const controller = new AbortController();
      abortRef.current = controller;
      const outcome = await searchUnified(text, near, sessionTokenRef.current, controller.signal);
      // Drop stale responses if the user kept typing OR the fetch was aborted
      if (lastQueryRef.current !== text || controller.signal.aborted) return;
      setResults(outcome.results);
      setAttribution(outcome.attribution);
      setLoading(false);
      hasSearchedRef.current = true;
      // Cache result (LRU cap: 50 entries — evict oldest)
      if (queryCacheRef.current.size >= 50) {
        const firstKey = queryCacheRef.current.keys().next().value;
        if (firstKey !== undefined) queryCacheRef.current.delete(firstKey);
      }
      queryCacheRef.current.set(cacheKey, outcome);
    }, SEARCH_DEBOUNCE_MS);
  }, [near]);

  const handleSelect = useCallback(
    (item: AddressResult) => {
      setQuery(item.title);
      setResults([]);
      setFocused(false);
      Keyboard.dismiss();
      // Session ends on selection — discard the token so the next search
      // starts fresh (Google bills per-session, reusing the token after
      // select would mix unrelated typing into one billable session).
      sessionTokenRef.current = null;
      // T1.7 — cancel any pending fetch (e.g. user typed + tapped result fast)
      abortRef.current?.abort();
      hasSearchedRef.current = false;
      onSelect({ latitude: item.latitude, longitude: item.longitude, address: item.address });
      // PR 4b: background fire-and-forget — grow cuba_pois via Mapbox
      // lookup for selected Google/Supabase-miss results. Never blocks UX.
      if (item._src) {
        void importPoiFromSearch(item._src, getSupabaseClient());
      }
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    setQuery('');
    setResults([]);
    setAttribution(null);
    setLoading(false);
    sessionTokenRef.current = null;
    // T1.7 — cancel pending fetch + reset empty-state flag
    abortRef.current?.abort();
    hasSearchedRef.current = false;
    inputRef.current?.focus();
  }, []);

  // T1.7 — show empty state when we've done at least one search for this
  // query and it returned nothing. Gated by `hasSearchedRef` to avoid
  // flashing "no results" before the debounce fires.
  const showEmptyState = focused
    && !loading
    && results.length === 0
    && query.trim().length >= 2
    && hasSearchedRef.current;
  const showDropdown = focused && (results.length > 0 || loading || showEmptyState);

  return (
    <View style={styles.wrapper}>
      {/* Input row */}
      <View style={styles.inputRow}>
        <Ionicons name="search-outline" size={18} color={colors.neutral[400]} style={styles.searchIcon} />
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={handleChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // Delay so taps on results register first
            setTimeout(() => setFocused(false), 200);
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.neutral[500]}
          style={styles.input}
          returnKeyType="search"
          clearButtonMode="never"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {loading && (
          <ActivityIndicator size="small" color={colors.brand.orange} style={{ marginRight: 8 }} />
        )}
        {query.length > 0 && !loading && (
          <Pressable onPress={handleClear} hitSlop={8} style={{ marginRight: 8 }}>
            <Ionicons name="close-circle" size={18} color={colors.neutral[500]} />
          </Pressable>
        )}
      </View>

      {/* Dropdown results */}
      {showDropdown && (
        <View style={styles.dropdown}>
          {results.length === 0 && loading ? (
            <View style={styles.dropdownEmpty}>
              <ActivityIndicator size="small" color={colors.brand.orange} />
            </View>
          ) : showEmptyState ? (
            /* T1.7 — explicit empty state replaces silent spinner */
            <View style={styles.dropdownEmpty}>
              <Ionicons name="search-outline" size={20} color={colors.neutral[500]} style={{ marginBottom: 6 }} />
              <Text variant="body" style={{ color: colors.neutral[400], fontSize: 13, textAlign: 'center' }}>
                No se encontraron lugares cerca
              </Text>
              <Text variant="caption" style={{ color: colors.neutral[500], fontSize: 11, marginTop: 4, textAlign: 'center' }}>
                Probá con otro nombre o calle
              </Text>
            </View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="always"
              scrollEnabled={results.length > 3}
              style={{ maxHeight: 220 }}
              ListFooterComponent={
                attribution ? <SourceAttribution source={attribution} isDark /> : null
              }
              renderItem={({ item, index }) => (
                <Pressable
                  onPress={() => handleSelect(item)}
                  style={({ pressed }) => [
                    styles.resultItem,
                    index < results.length - 1 && styles.resultItemBorder,
                    pressed && styles.resultItemPressed,
                  ]}
                >
                  {item.emoji ? (
                    <Text
                      style={{ fontSize: 18, width: 22, textAlign: 'center', marginRight: 8, marginTop: 1 }}
                    >
                      {item.emoji}
                    </Text>
                  ) : (
                    <Ionicons
                      name={item.isPoi ? 'business-outline' : 'location-outline'}
                      size={16}
                      color={colors.brand.orange}
                      style={{ marginRight: 10, marginTop: 1 }}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text
                      variant="body"
                      numberOfLines={1}
                      style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}
                    >
                      {item.title}
                    </Text>
                    {item.subtitle ? (
                      <Text
                        variant="caption"
                        numberOfLines={1}
                        style={{ color: colors.neutral[400], marginTop: 1 }}
                      >
                        {item.subtitle}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              )}
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
    zIndex: 50,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    height: 48,
  },
  searchIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    color: '#fff',
    fontSize: 15,
    fontFamily: 'Inter',
    height: '100%',
  },
  dropdown: {
    position: 'absolute',
    top: 52,
    left: 0,
    right: 0,
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 10,
  },
  dropdownEmpty: {
    padding: 16,
    alignItems: 'center',
  },
  resultItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  resultItemBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2A2A2A',
  },
  resultItemPressed: {
    backgroundColor: '#252525',
  },
});
