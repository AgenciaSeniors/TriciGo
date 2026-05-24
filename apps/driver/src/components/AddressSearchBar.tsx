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
  tricigoCategoryEmoji,
  importPoiFromSearch,
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

async function searchUnified(query: string, near: GeoPoint | null): Promise<SearchOutcome> {
  if (query.trim().length < 2) return { results: [], attribution: null };

  // search_pois_smart already detects category intent (e.g. "Bar" /
  // "Hospital") and sinks generic OSM placeholders. When a category
  // keyword is detected, suppress the streets fetch so searching "Bar"
  // doesn't surface "Bartolomé*" streets — we only want bars.
  const poiResults = await searchPoisSupabase(query, near, 6).catch(() => [] as SearchBoxResult[]);
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

  const highSpecPois = poiResults.filter(r => r.specificity >= 0.8).map(toResult);
  const lowSpecPois  = poiResults.filter(r => r.specificity <  0.8).map(toResult);
  const streets      = streetResults.map(toResult);

  const merged = [...highSpecPois, ...streets, ...lowSpecPois];
  if (merged.length > 0) return { results: merged.slice(0, 8), attribution: null };

  // PR 4 of POI parity — Supabase had nothing, try Google Places (best
  // Cuban long-tail coverage) → Mapbox SearchBox → finally Nominatim.
  const unified = await searchAddressUnified(query, getSupabaseClient(), near).catch(() => [] as SearchBoxResult[]);
  if (unified.length > 0) {
    return {
      // PR 4b: attach the original SearchBoxResult so handleSelect can
      // fire-and-forget the import-mapbox-poi EF on Google selections.
      results: unified.map((r, idx) => ({ ...toResult(r, idx), _src: r })),
      attribution: inferAttributionSource(unified),
    };
  }

  // Final fallback: Nominatim via the existing searchAddress helper.
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

  const handleChangeText = useCallback((text: string) => {
    setQuery(text);
    lastQueryRef.current = text;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const outcome = await searchUnified(text, near);
      // Drop stale responses if the user kept typing
      if (lastQueryRef.current !== text) return;
      setResults(outcome.results);
      setAttribution(outcome.attribution);
      setLoading(false);
    }, 350);
  }, [near]);

  const handleSelect = useCallback(
    (item: AddressResult) => {
      setQuery(item.title);
      setResults([]);
      setFocused(false);
      Keyboard.dismiss();
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
    setLoading(false);
    inputRef.current?.focus();
  }, []);

  const showDropdown = focused && (results.length > 0 || loading);

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
