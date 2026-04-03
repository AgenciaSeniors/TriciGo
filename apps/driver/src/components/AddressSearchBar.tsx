import React, { useState, useRef, useCallback } from 'react';
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
import { Text } from '@tricigo/ui/Text';
import { colors } from '@tricigo/theme';

// ─── Nominatim config (Cuba-specific, same as web app) ──────────────────────
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
// Cuba bounding box: west, south, east, north
const CUBA_VIEWBOX = '-84.9,19.8,-74.1,23.3';

interface AddressResult {
  id: string;
  address: string;
  shortName: string;
  latitude: number;
  longitude: number;
}

interface AddressSearchBarProps {
  /** Called when the user selects a result — parent should move camera there */
  onSelect: (result: { latitude: number; longitude: number; address: string }) => void;
  placeholder?: string;
}

async function searchNominatim(query: string): Promise<AddressResult[]> {
  if (query.trim().length < 2) return [];
  try {
    const url =
      `${NOMINATIM_BASE}?q=${encodeURIComponent(query)}` +
      `&countrycodes=cu&limit=6&format=json&addressdetails=1` +
      `&bounded=1&viewbox=${CUBA_VIEWBOX}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'Accept-Language': 'es', 'User-Agent': 'TriciGoDriver/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch {
      clearTimeout(timeoutId);
      return [];
    }
    if (!res.ok) return [];
    const data: any[] = await res.json();

    return data.map((item, idx) => {
      // Build a short human-friendly name
      const addr = item.address ?? {};
      const parts: string[] = [];
      if (addr.road) parts.push(addr.road);
      if (addr.suburb || addr.neighbourhood) parts.push(addr.suburb ?? addr.neighbourhood);
      if (addr.city || addr.town || addr.municipality) parts.push(addr.city ?? addr.town ?? addr.municipality);
      const shortName = parts.length ? parts.join(', ') : item.display_name.split(',').slice(0, 2).join(',');

      return {
        id: item.place_id?.toString() ?? `${idx}`,
        address: item.display_name,
        shortName: shortName.trim(),
        latitude: parseFloat(item.lat),
        longitude: parseFloat(item.lon),
      };
    });
  } catch {
    return [];
  }
}

export function AddressSearchBar({ onSelect, placeholder = 'Buscar dirección...' }: AddressSearchBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  const handleChangeText = useCallback((text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const found = await searchNominatim(text);
      setResults(found);
      setLoading(false);
    }, 300);
  }, []);

  const handleSelect = useCallback(
    (item: AddressResult) => {
      setQuery(item.shortName);
      setResults([]);
      setFocused(false);
      Keyboard.dismiss();
      onSelect({ latitude: item.latitude, longitude: item.longitude, address: item.address });
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
              renderItem={({ item, index }) => (
                <Pressable
                  onPress={() => handleSelect(item)}
                  style={({ pressed }) => [
                    styles.resultItem,
                    index < results.length - 1 && styles.resultItemBorder,
                    pressed && styles.resultItemPressed,
                  ]}
                >
                  <Ionicons
                    name="location-outline"
                    size={16}
                    color={colors.brand.orange}
                    style={{ marginRight: 10, marginTop: 1 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      variant="body"
                      numberOfLines={1}
                      style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}
                    >
                      {item.shortName}
                    </Text>
                    <Text
                      variant="caption"
                      numberOfLines={1}
                      style={{ color: colors.neutral[400], marginTop: 1 }}
                    >
                      {item.address}
                    </Text>
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
    fontFamily: 'Montserrat',
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
