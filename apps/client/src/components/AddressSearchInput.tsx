import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, TextInput, Pressable, ActivityIndicator, ScrollView, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Text } from '@tricigo/ui/Text';
import { searchAddress, reverseGeocode, HAVANA_PRESETS, trackEvent, triggerSelection, haversineDistance, fuzzyMatch, enrichWithCrossStreets, isGenericStreetAddress, parseCubanAddress, lookupIntersectionPoint, suggestCrossStreetsSupabase, searchPoisSupabase, searchStreetsSupabase, tricigoCategoryEmoji, searchAddressUnified, importPoiFromSearch } from '@tricigo/utils';
import { SourceAttribution, inferAttributionSource } from '@tricigo/ui';
import { getSupabaseClient } from '@tricigo/api';
import type { GeoPoint, AddressSearchResult, SearchBoxResult } from '@tricigo/utils';
import type { SavedLocation } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import type { RecentAddress } from '@/services/recentAddresses';
import type { PredictedDestination } from '@tricigo/utils';
import { getCachedResults, setCachedResults } from '@/services/geocodeCache';

/** Skeleton placeholder rows shown while searching */
function SkeletonRows() {
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  return (
    <>
      {[0, 1, 2].map((i) => (
        <Animated.View
          key={`skel-${i}`}
          style={{ opacity: anim, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center' }}
        >
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: isDark ? darkColors.background.tertiary : '#e5e5e5' }} />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <View style={{ height: 12, backgroundColor: isDark ? darkColors.background.tertiary : '#e5e5e5', borderRadius: 4, width: `${85 - i * 15}%` as any }} />
            <View style={{ height: 10, backgroundColor: isDark ? darkColors.background.secondary : '#f0f0f0', borderRadius: 4, width: `${60 - i * 10}%` as any, marginTop: 6 }} />
          </View>
        </Animated.View>
      ))}
    </>
  );
}

interface AddressSearchInputProps {
  placeholder?: string;
  selectedAddress?: string | null;
  onSelect: (address: string, location: GeoPoint) => void;
  /** User's saved locations from customer profile */
  savedLocations?: SavedLocation[];
  /** Recently used addresses from AsyncStorage */
  recentAddresses?: RecentAddress[];
  /** Predicted destinations based on ride history */
  predictions?: PredictedDestination[];
  /** Show "Use my location" option (for pickup only) */
  showUseMyLocation?: boolean;
  /** Callback to open the "pick on map" screen */
  onPickOnMap?: () => void;
  /** When true, component starts expanded with suggestions visible */
  autoExpand?: boolean;
}

function AddressSearchInputInner({
  placeholder,
  selectedAddress,
  onSelect,
  savedLocations = [],
  recentAddresses = [],
  predictions = [],
  showUseMyLocation = false,
  onPickOnMap,
  autoExpand = false,
}: AddressSearchInputProps) {
  const { t } = useTranslation('rider');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isExpanded, setIsExpanded] = useState(autoExpand);
  const [isLocating, setIsLocating] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  // PR 4 of POI parity — when external search (Google/Mapbox) contributes
  // results, we surface attribution at the bottom of the dropdown per TOS.
  const [attribution, setAttribution] = useState<'google' | 'mapbox' | 'mixed' | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef<string>('');
  const [userLocation, setUserLocation] = useState<GeoPoint | null>(null);

  // Fetch user location once for distance display
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getLastKnownPositionAsync();
        if (!cancelled && pos) {
          setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced search with cache + offline fallback
  const handleTextChange = useCallback((text: string) => {
    setQuery(text);
    lastQueryRef.current = text;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (text.trim().length < 2) {
      setResults([]);
      setIsSearching(false);
      setIsOffline(false);
      setAttribution(null);
      return;
    }

    setIsSearching(true);
    setIsOffline(false);
    debounceRef.current = setTimeout(async () => {
      if (lastQueryRef.current !== text) return;
      try {
        // ── Cuban address parsing (e.g. "Castillo e/ Fernandina y Pila") ──
        const cubanParsed = parseCubanAddress(text);

        // Partial → suggest cross-streets in real-time
        if (cubanParsed?.partial) {
          const loc = userLocation ?? undefined;
          if (cubanParsed.partial === 'waiting_cross1' && cubanParsed.main) {
            const crossStreets = await suggestCrossStreetsSupabase(cubanParsed.main, loc ? { latitude: loc.latitude, longitude: loc.longitude } : undefined);
            if (lastQueryRef.current !== text) return;
            if (crossStreets.length > 0) {
              const suggestions: AddressSearchResult[] = crossStreets.map(cs => {
                const addr = `${cubanParsed.main} e/ ${cs}`;
                return { address: addr, displayName: addr, latitude: loc?.latitude ?? 23.1136, longitude: loc?.longitude ?? -82.3666 };
              });
              setResults(suggestions);
              setIsSearching(false);
              return;
            }
          } else if (cubanParsed.partial === 'waiting_cross2' && cubanParsed.cross1) {
            const crossStreets = await suggestCrossStreetsSupabase(cubanParsed.main, loc ? { latitude: loc.latitude, longitude: loc.longitude } : undefined);
            if (lastQueryRef.current !== text) return;
            // Filter out the first cross-street already typed
            const filtered = crossStreets.filter(cs => cs.toLowerCase() !== cubanParsed.cross1.toLowerCase());
            if (filtered.length > 0) {
              const suggestions: AddressSearchResult[] = filtered.map(cs => {
                const addr = `${cubanParsed.main} e/ ${cubanParsed.cross1} y ${cs}`;
                return { address: addr, displayName: addr, latitude: loc?.latitude ?? 23.1136, longitude: loc?.longitude ?? -82.3666 };
              });
              setResults(suggestions);
              setIsSearching(false);
              return;
            }
          }
        }

        // Complete Cuban address → resolve intersection via Supabase (~5ms)
        if (cubanParsed && !cubanParsed.partial && cubanParsed.cross1) {
          const intersection = await lookupIntersectionPoint(
            cubanParsed.main, cubanParsed.cross1, cubanParsed.cross2,
            userLocation ? { latitude: userLocation.latitude, longitude: userLocation.longitude } : undefined,
          );
          if (lastQueryRef.current !== text) return;
          if (intersection) {
            setResults([{
              address: intersection.address,
              displayName: intersection.address,
              latitude: intersection.latitude,
              longitude: intersection.longitude,
            }]);
            setIsSearching(false);
            return;
          }
          // If no intersection found, fall through to normal search
        }

        // ── Smart POI search ──
        // search_pois_smart already detects category intent (e.g. "Bar"
        // → bar category; "consultorio del medico" → hospital), mixes
        // name + category matches, and sinks generic-name placeholders.
        // When the user typed a category keyword (matchedCategory != null
        // on the rows), suppress the streets fetch entirely — searching
        // "Bar" should not surface streets named "Bartolomé*". When the
        // query has no detected category, run streets in parallel for
        // address-style queries like "Calle 23 e/ M y N".
        const poiResults = await searchPoisSupabase(text, userLocation, 6);
        const detectedCategory = poiResults.find(r => r.matchedCategory)?.matchedCategory ?? null;
        const streetResults: SearchBoxResult[] = detectedCategory
          ? []                                                              // category search → drop streets
          : await searchStreetsSupabase(text, userLocation, 5);
        // Each result keeps a separate `displayName` (POI name) and
        // `address` so the dropdown can render the POI name as title
        // with the street as subtitle.
        const normalize = (r: SearchBoxResult): AddressSearchResult => ({
          address: r.address,
          latitude: r.latitude,
          longitude: r.longitude,
          // Only set displayName when different from address (e.g. a real
          // POI name). When equal, render a single-line result.
          displayName: r.place_name && r.place_name !== r.address ? r.place_name : undefined,
          tricigoCategory: r.tricigoCategory ?? null,
        });
        // The smart RPC already orders rows correctly (name match
        // quality, then is_admin, then distance, generic-name rows last).
        // Keep that order; only inject streets between high-spec and
        // low-spec POIs when streets are actually available (non-category
        // queries).
        const highSpecPois = poiResults.filter(r => r.specificity >= 0.8).map(normalize);
        const lowSpecPois  = poiResults.filter(r => r.specificity <  0.8).map(normalize);
        const merged: AddressSearchResult[] = [
          ...highSpecPois,
          ...streetResults.map(normalize),
          ...lowSpecPois,
        ];
        // PR 4 of POI parity — when local Supabase has no results, fall
        // back to Google Places (best Cuban coverage) and then Mapbox
        // SearchBox via the unified helper. Each result carries its
        // `source` so we can render proper TOS attribution below the list.
        let externalResults: AddressSearchResult[] = [];
        let externalAttribution: 'google' | 'mapbox' | 'mixed' | null = null;
        if (merged.length === 0) {
          const unified = await searchAddressUnified(text, getSupabaseClient(), userLocation);
          externalAttribution = inferAttributionSource(unified);
          externalResults = unified.length > 0
            // PR 4b: attach _src so handleSelectResult can fire-and-forget
            // import-mapbox-poi for Google-sourced selections.
            ? unified.map((r) => ({ ...normalize(r), _src: r }))
            : await searchAddress(text, 5, userLocation);
        }
        const searchResults: AddressSearchResult[] = merged.length > 0
          ? merged
          : externalResults;
        setResults(searchResults);
        setAttribution(externalAttribution);
        setIsOffline(false);
        // Cache successful results
        setCachedResults(text, searchResults).catch(() => {});

        // Background cross-street enrichment (only for generic streets, not POIs)
        const currentQuery = text;
        const toEnrich = searchResults.filter(r => r.latitude && r.longitude);
        Promise.allSettled(
          toEnrich.map(async (r, idx) => {
            if (!isGenericStreetAddress(r.address)) return null;
            const enriched = await enrichWithCrossStreets(r.latitude, r.longitude);
            if (enriched && lastQueryRef.current === currentQuery) {
              if (enriched.address.includes(' e/ ') || enriched.address.includes(' entre ')) {
                return { idx, address: enriched.address, latitude: enriched.latitude, longitude: enriched.longitude };
              }
            }
            return null;
          })
        ).then((settled) => {
          if (lastQueryRef.current !== currentQuery) return;
          setResults(prev => {
            const updated = [...prev];
            for (const s of settled) {
              if (s.status === 'fulfilled' && s.value) {
                const { idx, address, latitude, longitude } = s.value;
                if (updated[idx]) {
                  updated[idx] = { ...updated[idx], address, displayName: address, latitude, longitude };
                }
              }
            }
            return updated;
          });
        });
      } catch {
        // Network error — try cache fallback
        try {
          const cached = await getCachedResults(text);
          if (cached && cached.length > 0) {
            setResults(cached);
            setIsOffline(true);
          } else {
            setResults([]);
            setIsOffline(true);
          }
        } catch {
          setResults([]);
          setIsOffline(true);
        }
      } finally {
        setIsSearching(false);
      }
    }, 500);
  }, [userLocation]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSelectResult = (result: AddressSearchResult) => {
    triggerSelection();
    trackEvent('address_searched', { query: query.trim() });
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(result.address, { latitude: result.latitude, longitude: result.longitude });
    // PR 4b: background fire-and-forget — grow cuba_pois via Mapbox lookup
    // when the selection came from Google/Mapbox unified search. Never blocks UX.
    if (result._src) {
      void importPoiFromSearch(result._src, getSupabaseClient());
    }
  };

  const handleSelectSaved = (loc: SavedLocation) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(loc.address, { latitude: loc.latitude, longitude: loc.longitude });
  };

  const handleSelectRecent = (loc: RecentAddress) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(loc.address, { latitude: loc.latitude, longitude: loc.longitude });
  };

  const handleSelectPreset = (preset: typeof HAVANA_PRESETS[number]) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(preset.address, { latitude: preset.latitude, longitude: preset.longitude });
  };

  const handleUseMyLocation = async () => {
    if (isLocating) return;
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setIsLocating(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const address = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      setQuery('');
      setResults([]);
      setIsExpanded(false);
      onSelect(
        address ?? `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
        { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
      );
    } catch {
      setGeocodeError(t('home.geocode_error', { defaultValue: 'No se pudo obtener la dirección. Intenta escribirla manualmente.' }));
    } finally {
      setIsLocating(false);
    }
  };

  const handleFocus = () => {
    setIsExpanded(true);
    setGeocodeError(null);
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
  };

  // ── Local filtering (instant results while API is loading) ──
  const queryLower = query.trim().toLowerCase();
  const hasActiveQuery = queryLower.length >= 2;

  const handleSelectPrediction = (pred: PredictedDestination) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(pred.address, { latitude: pred.latitude, longitude: pred.longitude });
  };

  // UBER-1.3: Unified select handler for merged results.
  // Callers pass extra metadata (priority, source, icon, distanceKm)
  // used for UI badging upstream; the handler itself only needs the
  // coordinates, so accept the enrichment fields as optional so both
  // shapes type-check without an unsafe cast at each call site.
  const handleSelectMerged = (item: {
    address: string;
    displayName?: string;
    latitude: number;
    longitude: number;
    priority?: number;
    source?: string;
    icon?: string;
    distanceKm?: number | null;
  }) => {
    triggerSelection();
    trackEvent('address_searched', { query: query.trim() });
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    // Immediate select: if the item is a POI with a known street address,
    // combine "POI name, street" so the user sees the full label right
    // away (no flicker waiting for reverseGeocode background enrich).
    const initial = item.displayName && item.address && item.displayName !== item.address
      ? `${item.displayName}, ${item.address}`
      : item.address;
    onSelect(initial, { latitude: item.latitude, longitude: item.longitude });
    // Background: enrich with Cuban cross-street format via reverseGeocode.
    // reverseGeocode already prepends the nearest POI when it finds one,
    // so this naturally upgrades a "Calle 23" pick to "Hotel Bruzón, Calle 23
    // e/ X y Y, Vedado, La Habana" once the network returns.
    if (item.latitude && item.longitude) {
      reverseGeocode(item.latitude, item.longitude).then((enriched) => {
        if (!enriched || enriched === initial) return;
        // If the original was a POI name (not a street) and the enriched
        // address doesn't already include it, keep prepending it so the
        // user-visible label always carries the POI name.
        const poiHint = item.displayName ?? item.address;
        const looksLikeStreet =
          poiHint.includes(' e/ ') || poiHint.includes(' entre ') ||
          /^(Calle|Avenida|Calzada|Carretera|Av\.)\s/i.test(poiHint);
        const finalAddress = !looksLikeStreet && !enriched.includes(poiHint)
          ? `${poiHint}, ${enriched}`
          : enriched;
        onSelect(finalAddress, { latitude: item.latitude, longitude: item.longitude });
      }).catch(() => {});
    }
  };

  // UBER-1.3: Merge and rank all sources into a single list of up to 5.
  // displayName carries the POI name when distinct from address so the
  // dropdown can render two-line "POI / address" rows.
  type MergedResult = {
    address: string;
    displayName?: string;
    latitude: number;
    longitude: number;
    priority: number;
    source: string;
    distanceKm: number | null;
    icon: string;
    /**
     * Category emoji rendered to the left of the row. Set for POI rows
     * coming from `search_pois_smart` so the dropdown shows 🏥 / 🍺 / ⛽
     * / etc. at a glance. Streets and Mapbox-fallback rows leave this
     * undefined and fall back to the Ionicon `icon` field.
     */
    emoji?: string;
  };

  const mergedResults: MergedResult[] = (() => {
    if (!hasActiveQuery) return [];

    const matchedPreds = predictions
      .filter((p) => fuzzyMatch(queryLower, p.address))
      .map((p) => ({ address: p.address, latitude: p.latitude, longitude: p.longitude, priority: 1, source: 'prediction', icon: 'navigate-outline' as const }));

    const matchedSvd = savedLocations
      .filter((s) => fuzzyMatch(queryLower, s.address) || fuzzyMatch(queryLower, s.label))
      .map((s) => ({ address: s.address, latitude: s.latitude, longitude: s.longitude, priority: 2, source: 'saved', icon: 'star' as const }));

    const matchedRec = recentAddresses
      .filter((r) => fuzzyMatch(queryLower, r.address))
      .map((r) => ({ address: r.address, latitude: r.latitude, longitude: r.longitude, priority: 3, source: 'recent', icon: 'time-outline' as const }));

    const matchedApi = results
      .map((r) => ({
        address: r.address,
        displayName: r.displayName,                             // ← POI name passes through
        latitude: r.latitude,
        longitude: r.longitude,
        priority: 4,
        source: r.displayName ? 'poi' : 'api',                  // ← POI vs street
        icon: r.displayName ? ('business-outline' as const) : ('location-outline' as const),
        emoji: r.displayName ? tricigoCategoryEmoji(r.tricigoCategory) : undefined,
      }));

    const all = [...matchedPreds, ...matchedSvd, ...matchedRec, ...matchedApi];

    // Dedup: collapse near-coincident items (<100m) UNLESS one is a POI
    // and the other is a street — those represent different things even
    // at the same coordinate (e.g. the entrance of "Hotel Bruzón" sits on
    // "Calle 25"; both are useful suggestions).
    const deduped: typeof all = [];
    for (const item of all) {
      const isDup = deduped.some((d) => {
        const isPoiVsStreet =
          (d.source === 'poi') !== (item.source === 'poi');
        if (isPoiVsStreet) return false;
        const dist = haversineDistance(
          { latitude: d.latitude, longitude: d.longitude },
          { latitude: item.latitude, longitude: item.longitude },
        );
        return dist < 100;
      });
      if (!isDup) deduped.push(item);
    }

    // Sort by priority
    deduped.sort((a, b) => a.priority - b.priority);

    // Add distance from user
    return deduped.slice(0, 5).map((item) => ({
      ...item,
      distanceKm: userLocation
        ? haversineDistance(userLocation, { latitude: item.latitude, longitude: item.longitude }) / 1000
        : null,
    }));
  })();

  // "Did you mean?" — fuzzy match against presets when no results
  const didYouMean = useMemo(() => {
    if (!hasActiveQuery || mergedResults.length > 0 || isSearching) return null;
    const q = query.trim();
    if (q.length < 3) return null;
    for (const preset of HAVANA_PRESETS) {
      if (fuzzyMatch(q, preset.label, 0.4) || fuzzyMatch(q, preset.address, 0.4)) {
        return preset;
      }
    }
    return null;
  }, [hasActiveQuery, mergedResults.length, isSearching, query]);

  // If address is selected and not searching, show compact view
  if (selectedAddress && !isExpanded) {
    return (
      <Pressable
        className="bg-neutral-100 dark:bg-neutral-800 rounded-xl px-4 py-3 mb-2 flex-row items-center"
        onPress={() => setIsExpanded(true)}
      >
        <Ionicons name="location-outline" size={18} color={colors.brand.orange} />
        <Text variant="body" color="primary" className="flex-1 ml-2" numberOfLines={1}>
          {selectedAddress}
        </Text>
        <Ionicons name="pencil-outline" size={16} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />
      </Pressable>
    );
  }

  return (
    <View className="mb-2">
      {/* Search input */}
      <View className="bg-neutral-100 dark:bg-neutral-800 rounded-xl px-3 py-2 flex-row items-center" accessibilityRole="search">
        <Ionicons name="search-outline" size={18} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />
        <TextInput
          className="flex-1 text-base text-neutral-900 dark:text-neutral-100 ml-2 py-1"
          placeholder={placeholder ?? t('ride.search_address', { defaultValue: 'Buscar dirección...' })}
          placeholderTextColor={isDark ? darkColors.text.tertiary : colors.neutral[400]}
          value={query}
          onChangeText={handleTextChange}
          onFocus={handleFocus}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Buscar dirección"
        />
        {isSearching && <ActivityIndicator size="small" color={colors.brand.orange} />}
        {query.length > 0 && !isSearching && (
          <Pressable onPress={handleClear} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />
          </Pressable>
        )}
      </View>

      {/* Offline banner */}
      {isOffline && isExpanded && (
        <View className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2 mt-1 flex-row items-center">
          <Ionicons name="cloud-offline-outline" size={14} color={isDark ? '#fbbf24' : '#b45309'} />
          <Text variant="caption" style={{ color: isDark ? '#fbbf24' : '#b45309', marginLeft: 6, flex: 1 }}>
            {t('home.offline_results', { defaultValue: 'Sin conexión — mostrando resultados guardados' })}
          </Text>
        </View>
      )}

      {/* Geocoding error inline */}
      {geocodeError && (
        <View className="px-3 py-2 mt-1">
          <Text variant="caption" color="error">
            {geocodeError}
          </Text>
        </View>
      )}

      {/* Merged ranked results (query >= 2 chars) — max 5 */}
      {isExpanded && hasActiveQuery && (
        <View className="bg-white dark:bg-neutral-900 rounded-xl mt-1 border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {mergedResults.map((item, index) => (
              <Pressable
                key={`merged-${item.source}-${item.latitude}-${item.longitude}`}
                className={`px-4 flex-row items-center border-b border-neutral-100 dark:border-neutral-800 ${index === 0 ? 'py-4' : 'py-3'}`}
                onPress={() => handleSelectMerged(item)}
                accessibilityLabel={item.displayName ? `${item.displayName}, ${item.address}` : item.address}
              >
                {item.emoji ? (
                  <Text style={{ fontSize: index === 0 ? 20 : 18, width: 22, textAlign: 'center' }}>
                    {item.emoji}
                  </Text>
                ) : (
                  <Ionicons
                    name={item.icon as any}
                    size={index === 0 ? 18 : 16}
                    color={index === 0 ? colors.brand.orange : (isDark ? darkColors.text.secondary : colors.neutral[500])}
                  />
                )}
                <View className="flex-1 ml-2">
                  {/* Two-line layout when this is a POI with a separate
                      street address. Single-line when result is a plain
                      street/intersection (displayName === undefined). */}
                  {item.displayName ? (
                    <>
                      <Text
                        variant={index === 0 ? 'body' : 'bodySmall'}
                        className="font-semibold"
                        numberOfLines={1}
                      >
                        {item.displayName}
                      </Text>
                      {item.address && item.address !== item.displayName && (
                        <Text variant="caption" color="tertiary" numberOfLines={1} className="mt-0.5">
                          {item.address}
                        </Text>
                      )}
                    </>
                  ) : (
                    <Text
                      variant={index === 0 ? 'body' : 'bodySmall'}
                      className={index === 0 ? 'font-semibold' : ''}
                      numberOfLines={2}
                    >
                      {item.address}
                    </Text>
                  )}
                </View>
                {item.distanceKm != null && Number.isFinite(item.distanceKm) && item.distanceKm < 500 && (
                  <Text variant="caption" color="tertiary" className="ml-2">
                    {item.distanceKm < 1
                      ? `${Math.round(item.distanceKm * 1000)} m`
                      : `${item.distanceKm.toFixed(1)} km`}
                  </Text>
                )}
              </Pressable>
            ))}

            {/* PR 4 of POI parity — TOS attribution for external search providers */}
            {attribution && mergedResults.length > 0 && (
              <SourceAttribution source={attribution} />
            )}

            {/* Skeleton loading while API is searching and no local results */}
            {isSearching && mergedResults.length === 0 && (
              <SkeletonRows />
            )}

            {/* Searching indicator when local results exist but API still loading */}
            {isSearching && mergedResults.length > 0 && (
              <View className="px-4 py-2 flex-row items-center justify-center">
                <ActivityIndicator size="small" color={colors.neutral[300]} />
                <Text variant="caption" color="tertiary" className="ml-2">
                  {t('home.searching_more', { defaultValue: 'Buscando más resultados...' })}
                </Text>
              </View>
            )}

            {/* No results */}
            {!isSearching && mergedResults.length === 0 && (
              <View className="px-4 py-3">
                <Text variant="caption" color="secondary">
                  {t('home.no_address_results', { defaultValue: 'No se encontraron resultados' })}
                </Text>
                <Text variant="caption" color="tertiary" className="mt-1">
                  {t('home.try_another_address', { defaultValue: 'Intenta con otra dirección' })}
                </Text>
                {didYouMean && (
                  <Pressable
                    className="flex-row items-center mt-2 py-2"
                    onPress={() => handleSelectPreset(didYouMean)}
                  >
                    <Ionicons name="help-circle-outline" size={16} color={colors.brand.orange} />
                    <Text variant="bodySmall" color="accent" className="ml-2">
                      {t('home.did_you_mean', { defaultValue: '¿Quisiste decir' })}{' '}
                      <Text variant="bodySmall" className="font-semibold">{didYouMean.label}</Text>?
                    </Text>
                  </Pressable>
                )}
                {onPickOnMap && (
                  <Pressable
                    className="flex-row items-center mt-3 py-2"
                    onPress={() => { setIsExpanded(false); onPickOnMap(); }}
                  >
                    <Ionicons name="map-outline" size={16} color={colors.brand.orange} />
                    <Text variant="bodySmall" color="accent" className="ml-2 font-medium">
                      {t('ride.pick_on_map', { defaultValue: 'Elegir en el mapa' })}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </ScrollView>
        </View>
      )}

      {/* UBER-1.3: Suggestions panel (no active query) — merged ranked list */}
      {isExpanded && !hasActiveQuery && (
        <View className="mt-2">
          {/* Pick on map */}
          {onPickOnMap && (
            <Pressable
              className="flex-row items-center px-3 py-3 mb-1 rounded-lg bg-neutral-50 dark:bg-neutral-800"
              onPress={() => { setIsExpanded(false); onPickOnMap(); }}
            >
              <Ionicons name="map-outline" size={18} color={colors.brand.orange} />
              <Text variant="body" color="accent" className="flex-1 ml-3">
                {t('ride.pick_on_map', { defaultValue: 'Elegir en el mapa' })}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={isDark ? darkColors.text.secondary : colors.neutral[400]} />
            </Pressable>
          )}

          {/* Use my location */}
          {showUseMyLocation && (
            <Pressable
              className="flex-row items-center px-3 py-3 mb-1 rounded-lg bg-neutral-50 dark:bg-neutral-800"
              onPress={handleUseMyLocation}
              disabled={isLocating}
            >
              <Ionicons
                name="navigate"
                size={18}
                color={colors.brand.orange}
              />
              <Text variant="body" color="accent" className="flex-1 ml-3">
                {isLocating
                  ? t('ride.locating', { defaultValue: 'Obteniendo ubicación...' })
                  : t('ride.use_my_location', { defaultValue: 'Usar mi ubicación' })}
              </Text>
              {isLocating && <ActivityIndicator size="small" color={colors.brand.orange} />}
            </Pressable>
          )}

          {/* Saved locations section (Casa, Trabajo, etc.) — like web */}
          {savedLocations.length > 0 && (
            <View className="mb-2">
              <Text variant="caption" color="tertiary" className="px-1 mb-1" style={{ fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
                {t('ride.saved_locations', { defaultValue: 'Ubicaciones guardadas' })}
              </Text>
              {savedLocations.map((loc, i) => {
                const iconName = (loc as any).label?.toLowerCase().includes('casa') ? 'home' : (loc as any).label?.toLowerCase().includes('trabajo') ? 'briefcase' : 'star';
                return (
                  <Pressable
                    key={`saved-${i}`}
                    className="flex-row items-center px-3 py-3 rounded-lg"
                    style={{ borderBottomWidth: i < savedLocations.length - 1 ? 1 : 0, borderBottomColor: isDark ? '#333' : '#f0f0f0' }}
                    onPress={() => handleSelectMerged({ address: loc.address, latitude: loc.latitude, longitude: loc.longitude, priority: 0, source: 'saved', icon: iconName, distanceKm: null })}
                  >
                    <Ionicons name={iconName as any} size={18} color={colors.brand.orange} />
                    <View className="flex-1 ml-3">
                      <Text variant="body" className="font-semibold" numberOfLines={1}>{(loc as any).label || loc.address}</Text>
                      <Text variant="caption" color="tertiary" numberOfLines={1}>{loc.address}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Recent addresses section. Icon uses brand orange in both
              themes (matches Saved rows above) and text uses explicit
              primary color so dark mode meets WCAG 4.5:1 contrast. */}
          {recentAddresses.length > 0 && (
            <View className="mb-2">
              <Text variant="caption" color="tertiary" className="px-1 mb-1" style={{ fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
                {t('ride.recent_addresses', { defaultValue: 'Recientes' })}
              </Text>
              {recentAddresses.slice(0, 5).map((r, i) => (
                <Pressable
                  key={`recent-${i}`}
                  className="flex-row items-center px-3 py-2.5 rounded-lg"
                  onPress={() => handleSelectMerged({ address: r.address, latitude: r.latitude, longitude: r.longitude, priority: 0, source: 'recent', icon: 'time-outline', distanceKm: null })}
                >
                  <Ionicons name="time-outline" size={16} color={colors.brand.orange} />
                  <Text variant="bodySmall" color="primary" className="flex-1 ml-3 font-medium" numberOfLines={1}>{r.address}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* Predicted destinations ("Sugeridos"). Same contrast fix as
              Recientes — icon orange, text primary in dark mode. */}
          {predictions.length > 0 && (
            <View className="mb-2">
              <Text variant="caption" color="tertiary" className="px-1 mb-1" style={{ fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
                {t('ride.suggestions', { defaultValue: 'Sugeridos' })}
              </Text>
              {predictions.slice(0, 3).map((p, i) => (
                <Pressable
                  key={`pred-${i}`}
                  className="flex-row items-center px-3 py-2.5 rounded-lg"
                  onPress={() => handleSelectMerged({ address: p.address, latitude: p.latitude, longitude: p.longitude, priority: 0, source: 'prediction', icon: 'navigate-outline', distanceKm: null })}
                >
                  <Ionicons name={p.reason === 'frequent' ? 'star' : 'navigate-outline'} size={16} color={colors.brand.orange} />
                  <Text variant="bodySmall" color="primary" className="flex-1 ml-3 font-medium" numberOfLines={1}>{p.address}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* Popular places (presets) */}
          <View className="mt-3">
            <Text variant="caption" color="secondary" className="mb-2 px-1">
              {t('ride.popular_places', { defaultValue: 'Lugares populares' })}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {HAVANA_PRESETS.map((p) => (
                  <Pressable
                    key={p.label}
                    className={`px-3 py-1.5 rounded-full ${
                      selectedAddress === p.address
                        ? 'bg-primary-500'
                        : 'bg-neutral-100 dark:bg-neutral-800'
                    }`}
                    onPress={() => handleSelectPreset(p)}
                  >
                    <Text
                      variant="caption"
                      color={selectedAddress === p.address ? 'inverse' : 'secondary'}
                    >
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}

export const AddressSearchInput = React.memo(AddressSearchInputInner);
