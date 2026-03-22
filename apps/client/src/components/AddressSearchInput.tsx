import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, TextInput, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { Text } from '@tricigo/ui/Text';
import { searchAddress, reverseGeocode, HAVANA_PRESETS, trackEvent } from '@tricigo/utils';
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    trackEvent('address_searched', { query: query.trim() });
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(result.address, { latitude: result.latitude, longitude: result.longitude });
  };

  const handleSelectSaved = (loc: SavedLocation) => {
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(loc.address, { latitude: loc.latitude, longitude: loc.longitude });
  };

  const handleSelectRecent = (loc: RecentAddress) => {
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(loc.address, { latitude: loc.latitude, longitude: loc.longitude });
  };

  const handleSelectPreset = (preset: typeof HAVANA_PRESETS[number]) => {
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
      // Silently fail — user can type manually
    } finally {
      setIsLocating(false);
    }
  };

  const handleFocus = () => {
    setIsExpanded(true);
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
  };

  // ── Local filtering (instant results while API is loading) ──
  const queryLower = query.trim().toLowerCase();
  const hasActiveQuery = queryLower.length >= 2;

  const matchedPredictions = hasActiveQuery
    ? predictions.filter((p) => p.address.toLowerCase().includes(queryLower)).slice(0, 3)
    : [];

  const matchedSaved = hasActiveQuery
    ? savedLocations.filter(
        (s) =>
          s.address.toLowerCase().includes(queryLower) ||
          s.label.toLowerCase().includes(queryLower),
      ).slice(0, 3)
    : [];

  const matchedRecent = hasActiveQuery
    ? recentAddresses.filter((r) => r.address.toLowerCase().includes(queryLower)).slice(0, 3)
    : [];

  const handleSelectPrediction = (pred: PredictedDestination) => {
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    onSelect(pred.address, { latitude: pred.latitude, longitude: pred.longitude });
  };

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
      <View className="bg-neutral-100 rounded-xl px-3 py-2 flex-row items-center">
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
        />
        {isSearching && <ActivityIndicator size="small" color={colors.brand.orange} />}
        {query.length > 0 && !isSearching && (
          <Pressable onPress={handleClear} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={colors.neutral[400]} />
          </Pressable>
        )}
      </View>

      {/* ── Active search results (query >= 2 chars) ── */}
      {isExpanded && hasActiveQuery && (
        <View className="bg-white rounded-xl mt-1 border border-neutral-200 max-h-64 overflow-hidden">
          <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {/* Local matches: predictions */}
            {matchedPredictions.map((pred, index) => (
              <Pressable
                key={`pred-${index}`}
                className="px-4 py-3 flex-row items-center border-b border-neutral-100"
                onPress={() => handleSelectPrediction(pred)}
              >
                <Ionicons
                  name={pred.reason === 'time_pattern' ? 'time-outline' : pred.reason === 'frequent' ? 'star' : 'navigate-outline'}
                  size={16}
                  color={colors.brand.orange}
                />
                <Text variant="bodySmall" className="flex-1 ml-2" numberOfLines={2}>
                  {pred.address}
                </Text>
              </Pressable>
            ))}

            {/* Local matches: saved locations */}
            {matchedSaved.map((loc, index) => (
              <Pressable
                key={`saved-${index}`}
                className="px-4 py-3 flex-row items-center border-b border-neutral-100"
                onPress={() => handleSelectSaved(loc)}
              >
                <Ionicons name="star" size={16} color={colors.brand.orange} />
                <View className="flex-1 ml-2">
                  <Text variant="bodySmall" className="font-medium" numberOfLines={1}>
                    {loc.label}
                  </Text>
                  <Text variant="caption" color="secondary" numberOfLines={1}>
                    {loc.address}
                  </Text>
                </View>
              </Pressable>
            ))}

            {/* Local matches: recent addresses */}
            {matchedRecent.map((loc, index) => (
              <Pressable
                key={`recent-${index}`}
                className="px-4 py-3 flex-row items-center border-b border-neutral-100"
                onPress={() => handleSelectRecent(loc)}
              >
                <Ionicons name="time-outline" size={16} color={colors.neutral[500]} />
                <Text variant="bodySmall" className="flex-1 ml-2" numberOfLines={2}>
                  {loc.address}
                </Text>
              </Pressable>
            ))}

            {/* API results */}
            {results.map((result, index) => (
              <Pressable
                key={`api-${result.latitude}-${result.longitude}-${index}`}
                className="px-4 py-3 flex-row items-center border-b border-neutral-100"
                onPress={() => handleSelectResult(result)}
              >
                <Ionicons name="location-outline" size={16} color={colors.neutral[500]} />
                <Text variant="bodySmall" className="flex-1 ml-2" numberOfLines={2}>
                  {result.address}
                </Text>
              </Pressable>
            ))}

            {/* No results */}
            {!isSearching && results.length === 0 && matchedPredictions.length === 0 && matchedSaved.length === 0 && matchedRecent.length === 0 && (
              <View className="px-4 py-3">
                <Text variant="caption" color="secondary">
                  {t('ride.no_results', { defaultValue: 'No se encontraron resultados' })}
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      )}

      {/* ── Suggestions panel (no active query) ── */}
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

          {/* Predicted destinations */}
          {predictions.length > 0 && (
            <View className="mt-2">
              <Text variant="caption" color="secondary" className="mb-1 px-1">
                {t('prediction.suggested_for_you', { defaultValue: 'Sugerencias para ti' })}
              </Text>
              {predictions.slice(0, 3).map((pred, index) => (
                <Pressable
                  key={`pred-sug-${index}`}
                  className="flex-row items-center px-3 py-2.5 rounded-lg"
                  onPress={() => handleSelectPrediction(pred)}
                >
                  <Ionicons
                    name={pred.reason === 'time_pattern' ? 'time-outline' : pred.reason === 'frequent' ? 'star' : 'navigate-outline'}
                    size={16}
                    color={colors.brand.orange}
                  />
                  <View className="flex-1 ml-3">
                    <Text variant="bodySmall" className="font-medium" numberOfLines={1}>
                      {pred.address}
                    </Text>
                    <Text variant="caption" color="accent">
                      {pred.reason === 'time_pattern'
                        ? t('prediction.time_pattern', { defaultValue: 'Según tu horario' })
                        : pred.reason === 'frequent'
                          ? t('prediction.frequent', { defaultValue: 'Destino frecuente' })
                          : t('prediction.recent', { defaultValue: 'Viaje reciente' })}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {/* Saved places */}
          {savedLocations.length > 0 && (
            <View className="mt-2">
              <Text variant="caption" color="secondary" className="mb-1 px-1">
                {t('home.saved_places', { defaultValue: 'Lugares guardados' })}
              </Text>
              {savedLocations.slice(0, 5).map((loc, index) => (
                <Pressable
                  key={`saved-sug-${index}`}
                  className="flex-row items-center px-3 py-2.5 rounded-lg"
                  onPress={() => handleSelectSaved(loc)}
                >
                  <Ionicons name="star" size={16} color={colors.brand.orange} />
                  <View className="flex-1 ml-3">
                    <Text variant="bodySmall" className="font-medium" numberOfLines={1}>
                      {loc.label}
                    </Text>
                    <Text variant="caption" color="secondary" numberOfLines={1}>
                      {loc.address}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {/* Recent places */}
          {recentAddresses.length > 0 && (
            <View className="mt-2">
              <Text variant="caption" color="secondary" className="mb-1 px-1">
                {t('home.recent_places', { defaultValue: 'Lugares recientes' })}
              </Text>
              {recentAddresses.slice(0, 5).map((loc, index) => (
                <Pressable
                  key={`recent-sug-${index}`}
                  className="flex-row items-center px-3 py-2.5 rounded-lg"
                  onPress={() => handleSelectRecent(loc)}
                >
                  <Ionicons name="time-outline" size={16} color={colors.neutral[500]} />
                  <Text variant="bodySmall" className="flex-1 ml-3" numberOfLines={1}>
                    {loc.address}
                  </Text>
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
