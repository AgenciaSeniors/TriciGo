import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, TextInput, Pressable, ActivityIndicator, ScrollView, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from '@tricigo/ui/Text';
import { searchAddress, reverseGeocode, HAVANA_PRESETS, ALL_PRESETS, trackEvent, triggerSelection, haversineDistance, fuzzyMatch, enrichWithCrossStreets, shouldEnrichResult, parseCubanAddress, parseCornerQuery, isZoneLevelResult, lookupIntersectionPoint, suggestCrossStreetsSupabase, searchPoisSupabase, searchStreetsSupabase, searchResultEmoji, searchAddressUnified, newSessionToken, importPoiFromSearch, dedupeSearchResults, SEARCH_DEBOUNCE_MS, rankSearchResults, searchResultCap, findNearestPreset, historyMatchesQuery, tokenOverlapRatio, isProviderStreetResult, filterProviderStreetsByLocalAnchor } from '@tricigo/utils';
import { SourceAttribution, inferAttributionSource } from '@tricigo/ui';
import { getSupabaseClient } from '@tricigo/api';
import type { GeoPoint, AddressSearchResult, SearchBoxResult } from '@tricigo/utils';
import type { SavedLocation } from '@tricigo/types';
import { useTranslation } from '@tricigo/i18n';
import { useTokens } from '@/hooks/useTokens';
import { PartnerPlacesCarousel } from './PartnerPlacesCarousel';
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

/**
 * Category quick-searches for the idle sheet. The `term` stays SPANISH no
 * matter the UI language: `search_pois_smart`'s category detection speaks
 * Cuban Spanish, and the term is a query, not copy. Labels translate.
 */
const SEARCH_CATEGORIES = [
  { key: 'hospitals', term: 'hospital', icon: 'medkit-outline', tint: '#EF4444' },
  { key: 'pharmacies', term: 'farmacia', icon: 'bandage-outline', tint: '#10B981' },
  { key: 'restaurants', term: 'restaurante', icon: 'restaurant-outline', tint: '#FF4D00' },
  { key: 'hotels', term: 'hotel', icon: 'bed-outline', tint: '#3B82F6' },
  { key: 'parks', term: 'parque', icon: 'leaf-outline', tint: '#22C55E' },
  { key: 'terminals', term: 'terminal de ómnibus', icon: 'bus-outline', tint: '#F59E0B' },
  { key: 'banks', term: 'banco', icon: 'card-outline', tint: '#8B5CF6' },
  { key: 'cafes', term: 'cafetería', icon: 'cafe-outline', tint: '#A16207' },
] as const;

interface AddressSearchInputProps {
  placeholder?: string;
  /** Rider's current position. Drives the proximity-aware "Lugares
   *  populares" chips; without it the section hides — Havana presets
   *  hardcoded for someone standing in Santiago were worse than nothing. */
  near?: GeoPoint | null;
  selectedAddress?: string | null;
  /** 00537: `meta.confirmPin` marks a selection that resolved a STREET ADDRESS
   *  (not a named POI) from any search source — external geocoders mis-pin
   *  Cuban addresses (incident b428022b) and the local street DB is
   *  OSM-derived, so neither is trusted blindly. The caller should ask the
   *  user to confirm the pin on the map before booking to that point.
   *  Saved/recent/prediction selections never set it.
   *  `meta.zoneLike` marks a ZONE row (neighbourhood/municipality) from an
   *  external provider — it always sets `confirmPin` too, and the caller can
   *  show a "zona amplia" prompt instead of the generic one.
   *  `meta.notes` carries the details saved with a place (home/work/recents). */
  onSelect: (
    address: string,
    location: GeoPoint,
    meta?: { confirmPin?: boolean; zoneLike?: boolean; notes?: string },
  ) => void;
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
  near,
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
  const abortRef = useRef<AbortController | null>(null);
  const lastQueryRef = useRef<string>('');
  /** Bumped on every selection and on unmount; see handleSelectMerged. */
  const selectGenRef = useRef(0);
  /** True once a search for the CURRENT query has settled. Gates the empty
   *  state: without it "No se encontraron resultados" flashed between the
   *  moment a stale search cleared `isSearching` and the moment the new one
   *  answered (CLAUDE.md canon for the four search components). */
  const hasSearchedRef = useRef(false);
  // PR C of POI parity — Google Places session token. Generated lazily on
  // the first keystroke and reused for every keystroke + the Place Details
  // lookup until the user selects, clears, or empties the input. Bills the
  // entire typeahead as one "Autocomplete - Per Session" SKU instead of N
  // per-request charges (see newSessionToken docs).
  const sessionTokenRef = useRef<string | null>(null);
  const [userLocation, setUserLocation] = useState<GeoPoint | null>(null);
  // Frequent destinations (from ride history) used as a soft ranking prior:
  // results near a zone the rider visits often get a small in-bucket nudge.
  const frequentZonesRef = useRef<{ latitude: number; longitude: number }[]>([]);
  useEffect(() => {
    frequentZonesRef.current = predictions.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  }, [predictions]);

  // Resolve the rider's location for proximity-biased search. Two stages so a
  // null fix never silently biases search to Havana (Bug 1a): (1) instant
  // AsyncStorage 'last_known_location' read, (2) fresh GPS — last-known then a
  // current fix — which overrides the cache and is persisted back. Without the
  // getCurrentPositionAsync fallback, getLastKnownPositionAsync often resolves
  // null on a cold start in a province, leaving every search Havana-centered.
  // Mirrors ConfirmLocationScreen's two-stage acquisition.
  useEffect(() => {
    let cancelled = false;

    // Stage 1 — cache (instant). Don't clobber a fresh fix if Stage 2 won.
    AsyncStorage.getItem('last_known_location').then((raw) => {
      if (cancelled || !raw) return;
      try {
        const { latitude, longitude } = JSON.parse(raw);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setUserLocation((prev) => prev ?? { latitude, longitude });
        }
      } catch { /* malformed */ }
    }).catch(() => {});

    // Stage 2 — fresh GPS (overrides cache when it resolves)
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        let pos = await Location.getLastKnownPositionAsync();
        if (!pos) {
          pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        }
        if (!pos || cancelled) return;
        const latitude = pos.coords.latitude;
        const longitude = pos.coords.longitude;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        setUserLocation({ latitude, longitude });
        AsyncStorage.setItem(
          'last_known_location',
          JSON.stringify({ latitude, longitude }),
        ).catch(() => {});
      } catch { /* silent — keep cache or stay null (neutral nationwide search) */ }
    })();

    return () => { cancelled = true; };
  }, []);

  // Debounced search with cache + offline fallback
  const handleTextChange = useCallback((text: string) => {
    setQuery(text);
    lastQueryRef.current = text;
    hasSearchedRef.current = false;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    // Cancel any in-flight search so a slow earlier response can't land
    // after — and overwrite — the results for what the user types next.
    abortRef.current?.abort();

    if (text.trim().length < 1) {
      setResults([]);
      setIsSearching(false);
      setIsOffline(false);
      setAttribution(null);
      // Empty/short input ends the typeahead session. Drop the token so
      // the next keystroke starts a fresh billable session.
      sessionTokenRef.current = null;
      return;
    }

    // Lazy-init the session token on the first non-empty keystroke. Reused
    // for every subsequent debounced call until select/clear.
    if (sessionTokenRef.current === null) {
      sessionTokenRef.current = newSessionToken();
    }

    setIsSearching(true);
    setIsOffline(false);
    const controller = new AbortController();
    abortRef.current = controller;
    debounceRef.current = setTimeout(async () => {
      if (lastQueryRef.current !== text) return;
      try {
        // ── Cuban address parsing (e.g. "Castillo e/ Fernandina y Pila") ──
        const cubanParsed = parseCubanAddress(text);

        // Partial → suggest cross-streets in real-time.
        //
        // These rows are TEXT COMPLETIONS, not places: `suggest_cross_streets`
        // returns street names with no geometry. They carry needsResolution so
        // handleSelectMerged completes the search box instead of committing a
        // location; their coordinates are NaN precisely so that any code path
        // that ignored the flag would fail loudly instead of booking a ride to
        // a plausible-looking wrong point. (Until 00544 they were filled with
        // the rider's GPS, or the hardcoded Havana centre when there was no
        // fix — which is how a destination silently became an address ~1.5 km
        // away. It reached production; see AddressSearchResult.needsResolution.)
        if (cubanParsed?.partial) {
          const loc = userLocation ?? undefined;
          const mkSuggestion = (addr: string): AddressSearchResult => ({
            address: addr,
            displayName: addr,
            latitude: NaN,
            longitude: NaN,
            needsResolution: true,
          });
          if (cubanParsed.partial === 'waiting_cross1' && cubanParsed.main) {
            const crossStreets = await suggestCrossStreetsSupabase(cubanParsed.main, loc ? { latitude: loc.latitude, longitude: loc.longitude } : undefined);
            if (lastQueryRef.current !== text) return;
            if (crossStreets.length > 0) {
              setResults(crossStreets.map(cs => mkSuggestion(`${cubanParsed.main} e/ ${cs}`)));
              setIsSearching(false);
              return;
            }
          } else if (cubanParsed.partial === 'waiting_cross2' && cubanParsed.cross1) {
            const crossStreets = await suggestCrossStreetsSupabase(cubanParsed.main, loc ? { latitude: loc.latitude, longitude: loc.longitude } : undefined);
            if (lastQueryRef.current !== text) return;
            // Filter out the first cross-street already typed
            const filtered = crossStreets.filter(cs => cs.toLowerCase() !== cubanParsed.cross1.toLowerCase());
            if (filtered.length > 0) {
              setResults(filtered.map(cs => mkSuggestion(`${cubanParsed.main} e/ ${cubanParsed.cross1} y ${cs}`)));
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
        // PR F (2026-05-25) — flipped search order: Google PRIMARY, cuba_pois
        // SECONDARY. The user reported on-device 2026-05-25 that the airport
        // bug was caused by a bad cuba_pois result appearing above the
        // correct Google result. Going forward Google goes first; cuba_pois
        // rows that duplicate a Google result (by coord proximity ≤100 m or
        // name token overlap ≥0.7) are silently dropped from the secondary
        // list. PR E's cleanup already removed the worst cuba_pois offenders.
        //
        const normalize = (r: SearchBoxResult): AddressSearchResult => ({
          address: r.address,
          latitude: r.latitude,
          longitude: r.longitude,
          displayName: r.place_name && r.place_name !== r.address ? r.place_name : undefined,
          tricigoCategory: r.tricigoCategory ?? null,
          category: r.category,
          // A neighbourhood/municipality row must not be committed at its
          // centroid — it goes through pin confirmation (see onSelect meta).
          zoneLike: isZoneLevelResult(r) || undefined,
        });

        // Fire Google + cuba_pois + streets in parallel. Streets are always
        // fetched now (no longer gated on a detected category) so a real
        // street can't be hidden just because the query looked category-ish;
        // ranking decides the order. Google ~200-400ms via the EF; the local
        // RPCs ~50-100ms.
        // A one-character query is a street-grid query and nothing else. The
        // single-letter/single-digit grids of Vedado, Miramar and dozens of
        // repartos are 11% of every intersection in Cuba, and search_streets
        // (00553) answers them with exact matching. Google is skipped on
        // purpose: it bills a session for a query it cannot resolve, and
        // search_pois_smart would return pure category noise for "C".
        const gridOnly = text.trim().length === 1;

        // Cuban CORNER form ("23 y 12", "Infanta y San Lázaro", "Línea esq. a
        // G"). The server has resolved corners for months; the client never
        // asked because only the block form ("X e/ Y y Z") was parsed, so
        // "23 y 12" reached search_streets and came back as two unrelated
        // streets. Runs IN PARALLEL with the normal search and is only
        // PREPENDED on a hit — a venue literally named "Pan y Canela" keeps
        // its row, and a miss costs one ~5 ms RPC.
        const corner = cubanParsed ? null : parseCornerQuery(text);
        const cornerProximity = userLocation
          ? { latitude: userLocation.latitude, longitude: userLocation.longitude }
          : undefined;

        const [unifiedResults, poiResults, streetResults, cornerHit] = await Promise.all([
          gridOnly
            ? Promise.resolve<SearchBoxResult[]>([])
            : searchAddressUnified(text, getSupabaseClient(), userLocation, controller.signal, 10, sessionTokenRef.current ?? undefined),
          gridOnly ? Promise.resolve<SearchBoxResult[]>([]) : searchPoisSupabase(text, userLocation, 6),
          searchStreetsSupabase(text, userLocation, 8),
          corner
            ? lookupIntersectionPoint(corner.main, corner.cross1, undefined, cornerProximity).catch(() => null)
            : Promise.resolve(null),
        ]);

        const externalAttribution = inferAttributionSource(unifiedResults);

        // Drop cuba_pois / street rows that duplicate a higher-tier result
        // (coord ≤100m or name-token overlap ≥0.7), then rank the survivors by
        // proximity bucket (nearest wins) with text/specificity/source as the
        // in-bucket tie-break: a far-province Google hit can no longer sit
        // above a nearby street, while named places keep their edge among
        // equally-close results (the airport-bug guard lives in the score).
        //
        // Coordinate authority is split by row TYPE. dedupeSearchResults keeps
        // whichever list is `primary`, so seniority == coordinate authority:
        //  - VENUES: Google stays senior over cuba_pois (airport bug, PR F).
        //  - STREETS: the local street_intersections row is senior over a
        //    Google street row. Measured over 40 common Havana street names:
        //    Google returns the WRONG street for 19 ("Calle 23"→"Calle 230"
        //    13 km away) and mis-pins most of the rest, while the local row
        //    is a real surveyed corner. A Google street row that duplicates a
        //    local street is dropped; unique ones (streets we don't have)
        //    still surface.
        const googleVenues = unifiedResults.filter((r) => !isProviderStreetResult(r));
        const googleStreets = unifiedResults.filter(isProviderStreetResult);
        const dedupedPois = dedupeSearchResults(googleVenues, poiResults);
        const primaryVenues = [...googleVenues, ...dedupedPois];
        // When the local street DB found the query, Google "street" rows that
        // land far from it are dropped BEFORE dedupe. The name-overlap gate of
        // dedupeSearchResults (>=0.7) misses Google's exact miss ("Calle 23"
        // -> "Calle 230", overlap 0.5) so the wrong coordinate slipped through
        // and could win on `specificity`. Measured against 58 cached Cuban
        // street queries: Google was worse by >2 km in 30 of them, local in 4.
        const localStreetAnchor = streetResults[0]
          ? { latitude: streetResults[0].latitude, longitude: streetResults[0].longitude }
          : null;
        const trustedGoogleStreets = filterProviderStreetsByLocalAnchor(googleStreets, localStreetAnchor);
        const dedupedGoogleStreets = dedupeSearchResults(streetResults, trustedGoogleStreets);
        const primary = [...primaryVenues, ...dedupedGoogleStreets];
        const dedupedStreets = dedupeSearchResults(primary, streetResults);
        const ranked = rankSearchResults([...primary, ...dedupedStreets], text, userLocation, frequentZonesRef.current);

        // Normalize for display; keep _src on external rows so handleSelect
        // can fire-and-forget import-mapbox-poi for Google selections.
        const rankedResults: AddressSearchResult[] = ranked
          .slice(0, searchResultCap(text))
          .map((r) =>
            r.source === 'google' || r.source === 'mapbox' || r.source === 'searchbox'
              ? { ...normalize(r), _src: r }
              : normalize(r),
          );

        // The resolved corner goes first (displayName === address → it is a
        // street row, so it asks for pin confirmation like any other). Rows
        // that sit on the same corner (≤100 m) are duplicates and go.
        const searchResults: AddressSearchResult[] = cornerHit
          ? [
              {
                address: cornerHit.address,
                displayName: cornerHit.address,
                latitude: cornerHit.latitude,
                longitude: cornerHit.longitude,
                category: 'street',
              },
              ...rankedResults.filter((r) =>
                haversineDistance(
                  { latitude: r.latitude, longitude: r.longitude },
                  { latitude: cornerHit.latitude, longitude: cornerHit.longitude },
                ) > 100),
            ].slice(0, searchResultCap(text))
          : rankedResults;

        // Last-resort: nothing came back from anywhere → ultimate Mapbox/
        // Nominatim fallback (free, slower) so the user gets *something*.
        const finalResults: AddressSearchResult[] = searchResults.length > 0
          ? searchResults
          : await searchAddress(text, 5, userLocation);
        setResults(finalResults);
        setAttribution(externalAttribution);
        setIsOffline(false);
        // Cache successful results
        setCachedResults(text, searchResults).catch(() => {});

        // Background cross-street enrichment (only for generic streets, not POIs).
        // LABEL ONLY — the row keeps its own coordinates. enrichWithCrossStreets
        // used to hand back a re-resolved point that callers wrote over the row
        // the user was about to tap; that point came from a fuzzy 5 km lookup
        // and could land on an unrelated street. See its doc comment.
        const currentQuery = text;
        const toEnrich = searchResults.filter(r => r.latitude && r.longitude);
        Promise.allSettled(
          toEnrich.map(async (r) => {
            if (!shouldEnrichResult(r)) return null;
            const enriched = await enrichWithCrossStreets(r.latitude, r.longitude);
            if (enriched && lastQueryRef.current === currentQuery) {
              if (enriched.address.includes(' e/ ') || enriched.address.includes(' entre ')) {
                // Match back by identity, not array position: `results` can be
                // replaced while these promises are in flight, and an index
                // would then land the enrichment on a different row.
                return { lat: r.latitude, lng: r.longitude, address: enriched.address };
              }
            }
            return null;
          })
        ).then((settled) => {
          if (lastQueryRef.current !== currentQuery) return;
          setResults(prev => {
            let changed = false;
            const updated = prev.map((row) => {
              for (const s of settled) {
                if (s.status === 'fulfilled' && s.value
                    && s.value.lat === row.latitude && s.value.lng === row.longitude) {
                  changed = true;
                  return { ...row, address: s.value.address, displayName: s.value.address };
                }
              }
              return row;
            });
            return changed ? updated : prev;
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
        // Only the search for the query still in the box may settle the UI.
        // A slower, older search finishing here used to clear the spinner
        // while the newer one was still in flight — the empty-state flash.
        if (lastQueryRef.current === text) {
          hasSearchedRef.current = true;
          setIsSearching(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);
  }, [userLocation]);

  // Cleanup timeout on unmount
  useEffect(() => {
    // Capture the ref objects (not their .current) so the cleanup mutates the
    // live values without tripping the ref-in-cleanup lint rule.
    const selectGen = selectGenRef;
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
      // Invalidate any in-flight background label upgrade so it can't call
      // onSelect after this input is gone — that late write is what used to
      // revert a pin the rider had just corrected on the map.
      selectGen.current++;
    };
  }, []);

  const handleSelectResult = (result: AddressSearchResult) => {
    triggerSelection();
    trackEvent('address_searched', { query: query.trim() });
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    // Session ends on selection — drop the Google Places session token so
    // the next search starts a fresh billable session.
    sessionTokenRef.current = null;
    // 00537: same rule as handleSelectMerged — any street-address result
    // (no distinct POI name) confirms the pin; see onSelect meta.confirmPin.
    const zoneLike = !!result.zoneLike;
    onSelect(
      result.address,
      { latitude: result.latitude, longitude: result.longitude },
      { confirmPin: !result.displayName || result.displayName === result.address || zoneLike, zoneLike },
    );
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
    sessionTokenRef.current = null;
    onSelect(loc.address, { latitude: loc.latitude, longitude: loc.longitude });
  };

  const handleSelectRecent = (loc: RecentAddress) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    sessionTokenRef.current = null;
    onSelect(loc.address, { latitude: loc.latitude, longitude: loc.longitude });
  };

  const tokens = useTokens();

  // Presets worth offering are the ones the rider can actually ride to.
  // ALL_PRESETS mixes Havana landmarks with province-capital centers; keep
  // the closest few within 60 km and hide the section entirely elsewhere.
  const nearbyPresets = useMemo(() => {
    if (!near || !Number.isFinite(near.latitude) || !Number.isFinite(near.longitude)) return [];
    return ALL_PRESETS
      .map((p) => ({ p, d: haversineDistance(near, { latitude: p.latitude, longitude: p.longitude }) }))
      .filter((x) => x.d < 60_000)
      .sort((a, b) => a.d - b.d)
      .slice(0, 8)
      .map((x) => x.p);
  }, [near]);

  const handleSelectPreset = (preset: typeof HAVANA_PRESETS[number]) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    sessionTokenRef.current = null;
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
      sessionTokenRef.current = null;
      // Incident cd09ba9f: when reverse geocode finds nothing (data gap or
      // timeout), raw coordinates reached the driver's offer card. Fall back
      // to the nearest local preset ("Cerca de Vedado" — no network) first;
      // both fallback forms are sentinels the server backstop (00539)
      // upgrades with real intersection data at ride creation.
      const gpsPoint = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      const nearPreset = address ? null : findNearestPreset(gpsPoint, 5000);
      onSelect(
        address
          ?? (nearPreset ? `Cerca de ${nearPreset.label}` : `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
        gpsPoint,
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
    sessionTokenRef.current = null;
  };

  // ── Local filtering (instant results while API is loading) ──
  const queryLower = query.trim().toLowerCase();
  const hasActiveQuery = queryLower.length >= 2;

  const handleSelectPrediction = (pred: PredictedDestination) => {
    triggerSelection();
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    sessionTokenRef.current = null;
    onSelect(pred.address, { latitude: pred.latitude, longitude: pred.longitude });
  };

  // UBER-1.3: Unified select handler for merged results.
  // Callers pass extra metadata (priority, source, icon, distanceKm)
  // used for UI badging upstream; the handler itself only needs the
  // coordinates, so accept the enrichment fields as optional so both
  // shapes type-check without an unsafe cast at each call site.
  /**
   * Commit a row with real coordinates: collapse the input, tell the parent,
   * then upgrade the label in the background. Shared by the merged-list tap
   * and the one-tap cross-street resolution below.
   */
  const commitSelection = (item: {
    address: string;
    displayName?: string;
    latitude: number;
    longitude: number;
    streetLike?: boolean;
    zoneLike?: boolean;
  }) => {
    trackEvent('address_searched', { query: query.trim() });
    setQuery('');
    setResults([]);
    setIsExpanded(false);
    sessionTokenRef.current = null;
    // Immediate select: if the item is a POI with a known street address,
    // combine "POI name, street" so the user sees the full label right
    // away (no flicker waiting for reverseGeocode background enrich). Skip
    // the prefix when the address already starts with the name — a zone row
    // ("Vedado" / "Vedado, La Habana") would otherwise read "Vedado, Vedado".
    const initial = item.displayName && item.address && item.displayName !== item.address
      && !item.address.toLowerCase().startsWith(item.displayName.toLowerCase())
      ? `${item.displayName}, ${item.address}`
      : item.address;
    // 00537 (incident b428022b): every street-address search result asks for
    // pin confirmation — geocoders mis-pin Cuban addresses and the local
    // street DB is OSM-derived (see matchedApi mapping). Named POIs and
    // saved/recent/prediction rows (streetLike undefined) skip: those coords
    // were searched by name or already ridden to. A ZONE row (neighbourhood /
    // municipality) always confirms: its coordinate is a centroid, not a door.
    const zoneLike = !!item.zoneLike;
    const confirmPin = !!item.streetLike || zoneLike;
    // Generation guard for the background label upgrade below. Bumped on every
    // selection and on unmount so a slow reverseGeocode (up to ~6 s, it races
    // Overpass) can't land after the user already moved on.
    const selectGen = ++selectGenRef.current;
    onSelect(initial, { latitude: item.latitude, longitude: item.longitude }, { confirmPin, zoneLike });
    // Background: enrich with Cuban cross-street format via reverseGeocode.
    // reverseGeocode already prepends the nearest POI when it finds one,
    // so this naturally upgrades a "Calle 23" pick to "Hotel Bruzón, Calle 23
    // e/ X y Y, Vedado, La Habana" once the network returns.
    if (item.latitude && item.longitude) {
      reverseGeocode(item.latitude, item.longitude).then((enriched) => {
        if (!enriched || enriched === initial) return;
        // 00544: this second onSelect carries NO meta, so it used to overwrite
        // whatever the pin-confirmation screen had just written — reverting a
        // pin the rider had corrected by hand back to the original search
        // coordinates. Drop it if anything happened since.
        if (selectGen !== selectGenRef.current) return;
        // If the original was a POI name (not a street) and the enriched
        // address doesn't already include it, keep prepending it so the
        // user-visible label always carries the POI name.
        const poiHint = item.displayName ?? item.address;
        const looksLikeStreet =
          poiHint.includes(' e/ ') || poiHint.includes(' entre ') ||
          /^(Calle|Avenida|Calzada|Carretera|Av\.)\s/i.test(poiHint);
        const finalAddress = !looksLikeStreet && !zoneLike && !enriched.includes(poiHint)
          ? `${poiHint}, ${enriched}`
          : enriched;
        onSelect(finalAddress, { latitude: item.latitude, longitude: item.longitude });
      }).catch(() => {});
    }
  };

  const handleSelectMerged = (item: {
    address: string;
    displayName?: string;
    latitude: number;
    longitude: number;
    priority?: number;
    source?: string;
    icon?: string;
    distanceKm?: number | null;
    streetLike?: boolean;
    zoneLike?: boolean;
    needsResolution?: boolean;
  }) => {
    triggerSelection();

    // A cross-street suggestion is a TEXT COMPLETION with no geometry. Never
    // commit these — their lat/lng are NaN by design.
    if (item.needsResolution || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) {
      // One tap: a COMPLETE "X e/ Y y Z" completion is resolved right here
      // instead of being fed back into the box for the rider to tap the
      // same address a second time. The partial ones ("X e/ Y") still
      // complete the text so the next cross street can be suggested.
      const parsed = parseCubanAddress(item.address);
      if (parsed && !parsed.partial && parsed.cross1) {
        setQuery(item.address);
        lastQueryRef.current = item.address;
        setIsSearching(true);
        const loc = userLocation
          ? { latitude: userLocation.latitude, longitude: userLocation.longitude }
          : undefined;
        lookupIntersectionPoint(parsed.main, parsed.cross1, parsed.cross2, loc)
          .then((hit) => {
            if (lastQueryRef.current !== item.address) return;
            if (hit) {
              setIsSearching(false);
              commitSelection({
                address: hit.address,
                displayName: hit.address,
                latitude: hit.latitude,
                longitude: hit.longitude,
                streetLike: true,
              });
            } else {
              handleTextChange(item.address);
            }
          })
          .catch(() => {
            if (lastQueryRef.current === item.address) handleTextChange(item.address);
          });
        return;
      }
      handleTextChange(item.address);
      return;
    }

    commitSelection(item);
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
    /** See AddressSearchResult.zoneLike — forces pin confirmation. */
    zoneLike?: boolean;
  };

  const mergedResults: MergedResult[] = (() => {
    if (!hasActiveQuery) return [];

    // historyMatchesQuery, not fuzzyMatch: these rows sort ABOVE every search
    // result and then the list gets cut short, so a loose match here evicts
    // the row the rider is looking for. fuzzyMatch's fast path is
    // `address.includes(query)` over the FULL address, and nearly every Cuban
    // address contains "Calle" — measured, "cal" matched 4 of 5 realistic
    // recents and took 4 of the 5 visible slots.
    const matchedPreds = predictions
      .filter((p) => historyMatchesQuery(queryLower, p.address))
      .map((p) => ({ address: p.address, latitude: p.latitude, longitude: p.longitude, priority: 1, source: 'prediction', icon: 'navigate-outline' as const }));

    const matchedSvd = savedLocations
      .filter((s) => historyMatchesQuery(queryLower, s.address) || historyMatchesQuery(queryLower, s.label))
      .map((s) => ({ address: s.address, latitude: s.latitude, longitude: s.longitude, priority: 2, source: 'saved', icon: 'star' as const }));

    const matchedRec = recentAddresses
      .filter((r) => historyMatchesQuery(queryLower, r.address))
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
        emoji: searchResultEmoji({ tricigoCategory: r.tricigoCategory, category: r.category, place_name: r.displayName ?? r.address, address: r.address }),
        // 00537: street-address results confirm the pin regardless of source.
        // External geocoders mis-pin Cuban street addresses (incident
        // b428022b: 1,650 m off), and the local street_intersections data is
        // OSM-derived — not trusted enough to skip confirmation either
        // (product decision 2026-08-01). displayName === address covers rows
        // whose label was overwritten by the cross-street enrichment (which
        // also swaps in street_intersections coords). Named POIs keep
        // skipping: they're searched by name and pin reliably.
        streetLike: !r.displayName || r.displayName === r.address,
        // Cross-street text completions carry no geometry — see
        // handleSelectMerged, which completes the query instead of selecting.
        needsResolution: r.needsResolution,
        zoneLike: r.zoneLike,
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
        if (dist >= 100) return false;
        // Same sanity gate dedupeSearchResults applies before collapsing on
        // coordinates alone. Without it, two genuinely different places on the
        // same block (a hotel and a restaurant 50 m apart) merged into one and
        // whichever came first in `all` won — so a recent silently swallowed a
        // co-located search result.
        // History rows carry no displayName; only search results do.
        const labelOf = (x: typeof item): string =>
          ('displayName' in x && x.displayName ? x.displayName : x.address) || '';
        return tokenOverlapRatio(labelOf(d), labelOf(item)) >= 0.3;
      });
      if (!isDup) deduped.push(item);
    }

    // Sort by priority
    deduped.sort((a, b) => a.priority - b.priority);

    // PR I (2026-05-25): dynamic cap based on query specificity.
    // The "Hotel Boutique Malecon 663" bug surfaced because saved/recent
    // matches (priorities 2-3) can fill the top-5 slice and push real
    // POI/API matches (priority 4) off the visible list. For a specific
    // multi-word query the user is clearly looking for a particular
    // venue — raise the cap to 8 so the POI from Google/cuba_pois has
    // room to surface even when it ranks below saved/recent.
    //
    // Short queries (1-2 words like "hotel" or "casa") keep the tight
    // cap of 5 — those are exploratory and a long list is overwhelming.
    const queryWordCount = queryLower.split(/\s+/).filter(w => w.length > 0).length;
    const hasApiOrPoi = deduped.some((d) => d.source === 'api' || d.source === 'poi');
    const cap = (queryWordCount >= 3 && hasApiOrPoi) ? 8 : 6;

    // Slot budget. The cap-8-for-3-words rule above only widened the list; it
    // left the underlying problem, which is that priorities 1-3 are sorted
    // above priority 4 unconditionally and can therefore consume the whole
    // slice. Cap the history tiers at 2 whenever there are search results, so
    // at least 4 slots always belong to what the rider is actually typing.
    // With an empty search (or an empty query, handled above) history keeps
    // the full list — that is its real use case.
    const HISTORY_SLOTS = 2;
    const historyRows = deduped.filter((d) => d.priority < 4);
    const searchRows = deduped.filter((d) => d.priority === 4);
    const visible = searchRows.length > 0
      ? [...historyRows.slice(0, HISTORY_SLOTS), ...searchRows]
      : historyRows;

    // Add distance from user
    return visible.slice(0, cap).map((item) => ({
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
                      {item.zoneLike && (
                        <View className="flex-row items-center mt-0.5">
                          <Ionicons name="alert-circle-outline" size={12} color={colors.brand.orange} />
                          <Text variant="caption" numberOfLines={1} style={{ color: colors.brand.orange, marginLeft: 4 }}>
                            {t('ride.zone_caption', { defaultValue: 'Zona amplia — te pediremos ajustar el pin' })}
                          </Text>
                        </View>
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

            {/* No results — only once a search for THIS query has settled */}
            {!isSearching && hasSearchedRef.current && mergedResults.length === 0 && (
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
              {predictions.slice(0, 3).map((p, i) => {
                // Exhaustive on purpose (repo rule for enum maps): a new
                // reason from the server must fail tsc here, not silently
                // render as something it is not.
                const REASON_META: Record<import('@tricigo/utils').PredictionReason, { icon: string; chip: string }> = {
                  frequent: { icon: 'star', chip: t('ride.reason_frequent') },
                  time_pattern: { icon: 'time-outline', chip: t('ride.reason_time') },
                  recent: { icon: 'navigate-outline', chip: t('ride.reason_recent') },
                  popular: { icon: 'trending-up-outline', chip: t('ride.reason_popular') },
                };
                const meta = REASON_META[p.reason] ?? REASON_META.recent;
                const [head, ...rest] = p.address.split(', ');
                return (
                  <Pressable
                    key={`pred-${i}`}
                    className="flex-row items-center px-3 py-2.5 rounded-lg"
                    onPress={() => handleSelectMerged({ address: p.address, latitude: p.latitude, longitude: p.longitude, priority: 0, source: 'prediction', icon: 'navigate-outline', distanceKm: null })}
                  >
                    <Ionicons name={meta.icon as never} size={16} color={colors.brand.orange} />
                    <View className="flex-1 ml-3">
                      <Text variant="bodySmall" color="primary" className="font-medium" numberOfLines={1}>{head}</Text>
                      {rest.length > 0 && (
                        <Text variant="caption" color="tertiary" numberOfLines={1}>{rest.join(', ')}</Text>
                      )}
                    </View>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(255,77,0,0.10)' }}>
                      <Text variant="caption" style={{ fontSize: 10, color: colors.brand.orange, fontWeight: '600' }}>{meta.chip}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Category quick-searches — unlike history, these always exist.
              A fresh account saw a nearly empty sheet; these give it a
              useful, tappable body from the first session. */}
          <View className="mt-3">
            <Text variant="caption" color="tertiary" className="px-1 mb-2" style={{ fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
              {t('ride.search_categories')}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {SEARCH_CATEGORIES.map((c) => (
                <Pressable
                  key={c.key}
                  onPress={() => { void triggerSelection(); handleTextChange(c.term); }}
                  accessibilityRole="button"
                  accessibilityLabel={t(`ride.cat_${c.key}`)}
                  style={({ pressed }) => ({ width: '25%', alignItems: 'center', paddingVertical: 10, opacity: pressed ? 0.6 : 1 })}
                >
                  <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: `${c.tint}1A`, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
                    <Ionicons name={c.icon as never} size={22} color={c.tint} />
                  </View>
                  <Text variant="caption" color="secondary" style={{ fontSize: 11 }} numberOfLines={1}>
                    {t(`ride.cat_${c.key}`)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Partner places with fare discounts. The carousel hides itself
              when nothing is in range (or the table is still empty), so it
              costs nothing where the program hasn't launched yet. */}
          <PartnerPlacesCarousel
            latitude={near?.latitude ?? null}
            longitude={near?.longitude ?? null}
            tokens={tokens}
            onSelect={(pl) => handleSelectMerged({
              address: [pl.name, pl.address, pl.municipality].filter(Boolean).join(', '),
              latitude: pl.latitude,
              longitude: pl.longitude,
              priority: 0,
              source: 'recent',
              icon: 'pricetag-outline',
              distanceKm: null,
            })}
          />

          {/* Popular places — proximity-aware, hidden when nothing is near */}
          {nearbyPresets.length > 0 && (
          <View className="mt-3">
            <Text variant="caption" color="secondary" className="mb-2 px-1">
              {t('ride.popular_places', { defaultValue: 'Lugares populares' })}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {nearbyPresets.map((p) => (
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
          )}
        </View>
      )}
    </View>
  );
}

export const AddressSearchInput = React.memo(AddressSearchInputInner);
