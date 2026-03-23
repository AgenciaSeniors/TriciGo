import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Text } from '@tricigo/ui/Text';
import { searchAddress, reverseGeocode, HAVANA_PRESETS, trackEvent, triggerSelection, haversineDistance } from '@tricigo/utils';
import type { GeoPoint, AddressSearchResult } from '@tricigo/utils';
import type { SavedLocation } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import type { RecentAddress } from '@/services/recentAddresses';
import type { PredictedDestination } from '@tricigo/utils';

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
}

function AddressSearchInputInner({
  placeholder,
  selectedAddress,
  onSelect,
  savedLocations = [],
  recentAddresses = [],
  predictions = [],
  showUseMyLocation = false,
}: AddressSearchInputProps) {
  const { t } = useTranslation('rider');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Debounced search
  const handleTextChange = useCallback((text: string) => {
    setQuery(text);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (text.trim().length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const searchResults = await searchAddress(text, 5);
        setResults(searchResults);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 500);
  }, []);

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

  // UBER-1.3: Unified select handler for merged results
  const handleSelectMerged = (item: { address: string; latitude: number; longitude: number }) => {
    triggerSelection();
    trackEvent('address_searched', { query: query.trim() });
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(item.address, { latitude: item.latitude, longitude: item.longitude });
  };

  // UBER-1.3: Merge and rank all sources into a single list of 3
  type MergedResult = { address: string; latitude: number; longitude: number; priority: number; source: string; distanceKm: number | null; icon: string };

  const mergedResults: MergedResult[] = (() => {
    if (!hasActiveQuery) return [];

    const matchedPreds = predictions
      .filter((p) => p.address.toLowerCase().includes(queryLower))
      .map((p) => ({ address: p.address, latitude: p.latitude, longitude: p.longitude, priority: 1, source: 'prediction', icon: 'navigate-outline' as const }));

    const matchedSvd = savedLocations
      .filter((s) => s.address.toLowerCase().includes(queryLower) || s.label.toLowerCase().includes(queryLower))
      .map((s) => ({ address: s.address, latitude: s.latitude, longitude: s.longitude, priority: 2, source: 'saved', icon: 'star' as const }));

    const matchedRec = recentAddresses
      .filter((r) => r.address.toLowerCase().includes(queryLower))
      .map((r) => ({ address: r.address, latitude: r.latitude, longitude: r.longitude, priority: 3, source: 'recent', icon: 'time-outline' as const }));

    const matchedApi = results
      .map((r) => ({ address: r.address, latitude: r.latitude, longitude: r.longitude, priority: 4, source: 'api', icon: 'location-outline' as const }));

    const all = [...matchedPreds, ...matchedSvd, ...matchedRec, ...matchedApi];

    // Remove duplicates: if two items are within 100m, keep the one with lower priority number
    const deduped: typeof all = [];
    for (const item of all) {
      const isDup = deduped.some((d) => {
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
    return deduped.slice(0, 3).map((item) => ({
      ...item,
      distanceKm: userLocation
        ? haversineDistance(userLocation, { latitude: item.latitude, longitude: item.longitude }) / 1000
        : null,
    }));
  })();

  // If address is selected and not searching, show compact view
  if (selectedAddress && !isExpanded) {
    return (
      <Pressable
        className="bg-neutral-100 rounded-xl px-4 py-3 mb-2 flex-row items-center"
        onPress={() => setIsExpanded(true)}
      >
        <Ionicons name="location-outline" size={18} color={colors.brand.orange} />
        <Text variant="body" color="primary" className="flex-1 ml-2" numberOfLines={1}>
          {selectedAddress}
        </Text>
        <Ionicons name="pencil-outline" size={16} color={colors.neutral[400]} />
      </Pressable>
    );
  }

  return (
    <View className="mb-2">
      {/* Search input */}
      <View className="bg-neutral-100 rounded-xl px-3 py-2 flex-row items-center" accessibilityRole="search">
        <Ionicons name="search-outline" size={18} color={colors.neutral[400]} />
        <TextInput
          className="flex-1 text-base text-neutral-900 ml-2 py-1"
          placeholder={placeholder ?? t('ride.search_address', { defaultValue: 'Buscar dirección...' })}
          placeholderTextColor={colors.neutral[400]}
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
            <Ionicons name="close-circle" size={18} color={colors.neutral[400]} />
          </Pressable>
        )}
      </View>

      {/* Geocoding error inline */}
      {geocodeError && (
        <View className="px-3 py-2 mt-1">
          <Text variant="caption" color="error">
            {geocodeError}
          </Text>
        </View>
      )}

      {/* UBER-1.3: Merged ranked results (query >= 2 chars) — max 3 */}
      {isExpanded && hasActiveQuery && (
        <View className="bg-white rounded-xl mt-1 border border-neutral-200 overflow-hidden">
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {mergedResults.map((item, index) => (
              <Pressable
                key={`merged-${item.source}-${item.latitude}-${item.longitude}`}
                className={`px-4 flex-row items-center border-b border-neutral-100 ${index === 0 ? 'py-4' : 'py-3'}`}
                onPress={() => handleSelectMerged(item)}
                accessibilityLabel={item.address}
              >
                <Ionicons
                  name={item.icon as any}
                  size={index === 0 ? 18 : 16}
                  color={index === 0 ? colors.brand.orange : colors.neutral[500]}
                />
                <View className="flex-1 ml-2">
                  <Text
                    variant={index === 0 ? 'body' : 'bodySmall'}
                    className={index === 0 ? 'font-semibold' : ''}
                    numberOfLines={2}
                  >
                    {item.address}
                  </Text>
                </View>
                {item.distanceKm != null && (
                  <Text variant="caption" color="tertiary" className="ml-2">
                    {item.distanceKm < 1
                      ? `${Math.round(item.distanceKm * 1000)} m`
                      : `${item.distanceKm.toFixed(1)} km`}
                  </Text>
                )}
              </Pressable>
            ))}

            {/* No results */}
            {!isSearching && mergedResults.length === 0 && (
              <View className="px-4 py-3">
                <Text variant="caption" color="secondary">
                  {t('home.no_address_results', { defaultValue: 'No se encontraron resultados' })}
                </Text>
                <Text variant="caption" color="tertiary" className="mt-1">
                  {t('home.try_another_address', { defaultValue: 'Intenta con otra dirección' })}
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      )}

      {/* UBER-1.3: Suggestions panel (no active query) — merged ranked list */}
      {isExpanded && !hasActiveQuery && (
        <View className="mt-2">
          {/* Use my location */}
          {showUseMyLocation && (
            <Pressable
              className="flex-row items-center px-3 py-3 mb-1 rounded-lg bg-neutral-50"
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

          {/* Merged suggestion list: predictions > saved > recent, top 3 */}
          {(() => {
            const sugAll: MergedResult[] = [
              ...predictions.slice(0, 3).map((p) => ({
                address: p.address, latitude: p.latitude, longitude: p.longitude,
                priority: 1, source: 'prediction',
                icon: p.reason === 'time_pattern' ? 'time-outline' : p.reason === 'frequent' ? 'star' : 'navigate-outline',
                distanceKm: userLocation ? haversineDistance(userLocation, { latitude: p.latitude, longitude: p.longitude }) / 1000 : null,
              })),
              ...savedLocations.slice(0, 3).map((s) => ({
                address: s.address, latitude: s.latitude, longitude: s.longitude,
                priority: 2, source: 'saved', icon: 'star',
                distanceKm: userLocation ? haversineDistance(userLocation, { latitude: s.latitude, longitude: s.longitude }) / 1000 : null,
              })),
              ...recentAddresses.slice(0, 3).map((r) => ({
                address: r.address, latitude: r.latitude, longitude: r.longitude,
                priority: 3, source: 'recent', icon: 'time-outline',
                distanceKm: userLocation ? haversineDistance(userLocation, { latitude: r.latitude, longitude: r.longitude }) / 1000 : null,
              })),
            ];
            // Dedupe within 100m
            const deduped: typeof sugAll = [];
            for (const item of sugAll) {
              const isDup = deduped.some((d) =>
                haversineDistance({ latitude: d.latitude, longitude: d.longitude }, { latitude: item.latitude, longitude: item.longitude }) < 100
              );
              if (!isDup) deduped.push(item);
            }
            deduped.sort((a, b) => a.priority - b.priority);
            const top3 = deduped.slice(0, 3);

            if (top3.length === 0) return null;
            return top3.map((item, index) => (
              <Pressable
                key={`sug-${item.source}-${item.latitude}-${item.longitude}`}
                className={`flex-row items-center px-3 rounded-lg ${index === 0 ? 'py-3' : 'py-2.5'}`}
                onPress={() => handleSelectMerged(item)}
              >
                <Ionicons
                  name={item.icon as any}
                  size={index === 0 ? 18 : 16}
                  color={index === 0 ? colors.brand.orange : colors.neutral[500]}
                />
                <View className="flex-1 ml-3">
                  <Text
                    variant={index === 0 ? 'body' : 'bodySmall'}
                    className={index === 0 ? 'font-semibold' : 'font-medium'}
                    numberOfLines={1}
                  >
                    {item.address}
                  </Text>
                </View>
                {item.distanceKm != null && (
                  <Text variant="caption" color="tertiary">
                    {item.distanceKm < 1
                      ? `${Math.round(item.distanceKm * 1000)} m`
                      : `${item.distanceKm.toFixed(1)} km`}
                  </Text>
                )}
              </Pressable>
            ));
          })()}

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
                        : 'bg-neutral-100'
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
