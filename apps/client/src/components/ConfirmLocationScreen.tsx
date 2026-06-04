import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Pressable, Animated, Platform, Image, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';

// BUG-281: branded pin asset. The image is a white silhouette on a
// transparent background — RN tints it via the Image `tintColor` style
// so we can apply different brand colors per pickup/dropoff consistently
// across light/dark themes. BUG-292: pickup also uses this asset (was a
// flat green disc that looked indistinguishable from a POI dot — users
// thought their pickup was being snapped to a non-existent POI).
const ROUTE_PIN_ASSET = require('../../assets/markers/dropoff-pin.png');
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { reverseGeocode, reverseGeocodeStructured, MAP_STYLE_LIGHT } from '@tricigo/utils';
import type { GeoPoint, StructuredAddress } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import { getMapFallbackCoordLngLat } from '@/config/demo';

let _MapboxGL: any = undefined;
function getMapboxGL(): any {
  if (_MapboxGL !== undefined) return _MapboxGL;
  try { _MapboxGL = require('@rnmapbox/maps').default; } catch { _MapboxGL = null; }
  return _MapboxGL;
}

// Sync token init before MapView mounts (see note in RideMapView)
let _mapboxTokenApplied = false;
function ensureMapboxToken() {
  if (_mapboxTokenApplied || Platform.OS === 'web') return;
  const M = getMapboxGL();
  if (!M) return;
  try {
    const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
    M.setAccessToken(token);
    // BUG-216: setWellKnownTileServer removed (deprecated, was log noise)
    if (typeof M.setTelemetryEnabled === 'function') M.setTelemetryEnabled(false);
    _mapboxTokenApplied = true;
  } catch { /* retry via _layout */ }
}
ensureMapboxToken();

// Map fallback; Havana in prod, configurable for demo (see config/demo.ts).
const HAVANA_CENTER: [number, number] = getMapFallbackCoordLngLat();

interface ConfirmLocationScreenProps {
  mode: 'pickup' | 'dropoff';
  initialLocation?: GeoPoint | null;
  onConfirm: (address: string, location: GeoPoint) => void;
  onClose: () => void;
}

/**
 * Split a structured reverse-geocode result into the two display lines:
 * line1 = POI name (bold, only when a POI is within a few meters), line2 = the
 * street/locality address. Null result → show the raw coordinate on line2 so
 * the bar is never blank (Bug 2b). Pure so it's trivially testable.
 */
function toDisplay(
  s: StructuredAddress | null,
  lat: number,
  lng: number,
): { line1?: string; line2: string } {
  const coords = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (!s) return { line2: coords };
  const line2 = [s.street, s.municipality, s.province].filter(Boolean).join(', ');
  return { line1: s.poiName, line2: line2 || coords };
}

export function ConfirmLocationScreen({
  mode,
  initialLocation,
  onConfirm,
  onClose,
}: ConfirmLocationScreenProps) {
  ensureMapboxToken();
  const MapboxGL = getMapboxGL();
  const { t } = useTranslation('rider');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  // Two-line address display: line1 = POI name (when one sits within a few
  // meters), line2 = the street/locality address. line1 omitted → single line.
  const [display, setDisplay] = useState<{ line1?: string; line2: string } | null>(null);
  const centerRef = useRef<GeoPoint>(initialLocation ?? { latitude: 23.1136, longitude: -82.3666 });
  const [isGeocoding, setIsGeocoding] = useState(false);
  // Confirm button is decoupled from geocoding — see handleConfirm.
  const [confirming, setConfirming] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapRef = useRef<any>(null);

  // Shimmer animation for address bar
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isGeocoding) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(shimmerAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [isGeocoding]);

  const shimmerOpacity = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 1],
  });

  // Reverse geocode the center point
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const geocodeCenter = useCallback((lat: number, lng: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      setIsGeocoding(true);
      setDisplay(null); // Show shimmer

      // Retry up to 3 times
      let result: StructuredAddress | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!mountedRef.current) break;
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
        try {
          result = await reverseGeocodeStructured(lat, lng);
          if (result) break;
        } catch { /* continue to next attempt */ }
      }

      if (mountedRef.current) {
        setDisplay(toDisplay(result, lat, lng));
        setIsGeocoding(false);
      }
    }, 300);
  }, []);

  // Geocode initial location on mount
  useEffect(() => {
    if (initialLocation) {
      geocodeCenter(initialLocation.latitude, initialLocation.longitude);
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Geocode when map stops moving — get center from MapView ref
  const handleMapIdle = useCallback(async () => {
    try {
      if (mapRef.current?.getCenter) {
        const center = await mapRef.current.getCenter();
        if (center && Array.isArray(center) && center.length === 2) {
          const [lng, lat] = center;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            centerRef.current = { latitude: lat, longitude: lng };
            geocodeCenter(lat, lng);
            return;
          }
        }
      }
    } catch { /* fallback below */ }
    // Fallback: use whatever is in centerRef (initial location)
    geocodeCenter(centerRef.current.latitude, centerRef.current.longitude);
  }, [geocodeCenter]);

  // The confirm button used to be gated on `disabled={isGeocoding ||
  // !address}`, forcing the user to wait out the reverse-geocode (the
  // Overpass fallback runs 1-6s ×3 retries) before the screen advanced
  // — "avanza pero se demora". Confirming only needs the COORDINATE
  // (centerRef.current, always fresh from the map). We geocode the exact
  // center here, raced against a 3s cap; reverseGeocode is cached
  // (~55m cells) so when the address bar already resolved this spot it's
  // an instant cache hit. The tap is acknowledged immediately (spinner).
  const handleConfirm = async () => {
    if (confirming) return; // re-entrancy guard (double-tap)
    setConfirming(true);
    const center = centerRef.current;
    // Seed from whatever is already on screen (joined back to one string), then
    // prefer a fresh string geocode. reverseGeocode shares the structured cache,
    // so when the bar already resolved this spot it's an instant cache hit.
    let finalAddress = display ? [display.line1, display.line2].filter(Boolean).join(', ') : null;
    try {
      const fresh = await Promise.race([
        reverseGeocode(center.latitude, center.longitude),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (fresh) finalAddress = fresh;
    } catch { /* keep current display / fallback */ }
    // User may have tapped back while the geocode was in flight.
    if (!mountedRef.current) return;
    onConfirm(finalAddress || 'Ubicación seleccionada en el mapa', center);
  };

  const isPickup = mode === 'pickup';
  const pinColor = isPickup ? '#22c55e' : colors.brand.orange;

  // BUG-282 (revised) — two-stage user-location resolution: instant
  // AsyncStorage cache read, then fresh GPS fix that overrides it.
  // On first install the cache is empty, so without the GPS stage the
  // picker would open at the demo-city / Havana fallback even when the
  // user is somewhere else. Skipped entirely if the caller already
  // provided a valid initialLocation.
  const [cachedFallback, setCachedFallback] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (initialLocation) return;
    let cancelled = false;

    // Stage 1 — cache (instant)
    AsyncStorage.getItem('last_known_location').then((raw) => {
      if (cancelled || !raw) return;
      try {
        const { latitude, longitude } = JSON.parse(raw);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setCachedFallback([longitude, latitude]);
        }
      } catch { /* malformed */ }
    }).catch(() => {});

    // Stage 2 — fresh GPS (overrides cache when it resolves)
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted' || cancelled) return;
        let pos = await Location.getLastKnownPositionAsync();
        if (!pos) {
          pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
        }
        if (!pos || cancelled) return;
        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        setCachedFallback([lng, lat]);
        AsyncStorage.setItem(
          'last_known_location',
          JSON.stringify({ latitude: lat, longitude: lng }),
        ).catch(() => {});
      } catch { /* silent — fall back to cache or demo fallback */ }
    })();

    return () => { cancelled = true; };
  }, [initialLocation]);

  if (!MapboxGL) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: isDark ? darkColors.background.primary : colors.neutral[100] }}>
        <Text variant="body" color="secondary">
          {t('map.unavailable', { defaultValue: 'Mapa no disponible' })}
        </Text>
        <Button title={t('common.close', { defaultValue: 'Cerrar' })} onPress={onClose} className="mt-4" />
      </View>
    );
  }

  const initialCenter: [number, number] = initialLocation
    && Number.isFinite(initialLocation.longitude) && Number.isFinite(initialLocation.latitude)
    && (initialLocation.latitude !== 0 || initialLocation.longitude !== 0)
    ? [initialLocation.longitude, initialLocation.latitude]
    : (cachedFallback ?? HAVANA_CENTER);

  return (
    <View style={{ flex: 1 }}>
      {/* Map */}
      <MapboxGL.MapView
        ref={mapRef}
        style={{ flex: 1 }}
        styleURL={MAP_STYLE_LIGHT}
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
        scaleBarEnabled={false}
        scrollEnabled={true}
        zoomEnabled={true}
        pitchEnabled={false}
        rotateEnabled={false}
        onMapIdle={handleMapIdle}
      >
        {/* BUG-282 — key forces Camera remount when initialCenter resolves
            asynchronously (cachedFallback). defaultSettings only applies
            on first mount, so without the key change the camera would
            stay glued to HAVANA_CENTER for the entire picker session. */}
        <MapboxGL.Camera
          key={`cam-${initialCenter[0].toFixed(4)},${initialCenter[1].toFixed(4)}`}
          defaultSettings={{
            centerCoordinate: initialCenter,
            zoomLevel: 15,
          }}
        />
      </MapboxGL.MapView>

      {/* BUG-292 — Static center pin overlaid on map center.
         Pickup AND dropoff now share the same branded TriciGo pin silhouette,
         differentiated only by tint color (green for pickup, orange for
         dropoff). Previously the pickup was a flat 28-px disc which looked
         indistinguishable from a POI dot — users reported "when I drop the
         pickup on an empty street it says a POI dot and the address" because
         the green circle visually matched the POI category dots underneath.
         A real pin shape (vertical needle, transparent above the tip) leaves
         the street name DIRECTLY below the tip readable, fixing the
         companion "no veo las calles en la dirección" complaint. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {/* Drop shadow under the pin tip — anchors the pin to the map.
           translateY is the offset between the View center (where the
           shadow sits) and the visual tip of the pin asset (a few px
           higher than the asset midpoint). Same offset for both modes
           since the asset is the same. */}
        <View
          style={{
            width: 10,
            height: 4,
            borderRadius: 4,
            backgroundColor: 'rgba(0,0,0,0.22)',
            marginBottom: -2,
            transform: [{ translateY: 22 }],
          }}
        />
        <View
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 5,
          }}
        >
          <Image
            source={ROUTE_PIN_ASSET}
            style={{
              width: 44,
              height: 44,
              tintColor: pinColor,
            }}
            resizeMode="contain"
            accessibilityLabel={
              isPickup
                ? 'Pin de recogida TriciGo'
                : 'Pin de destino TriciGo'
            }
          />
        </View>
      </View>

      {/* Top address bar */}
      <View
        style={{
          position: 'absolute',
          top: Platform.OS === 'ios' ? 60 : 40,
          left: 16,
          right: 16,
          backgroundColor: isDark ? darkColors.card : '#fff',
          borderRadius: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          flexDirection: 'row',
          alignItems: 'center',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.1,
          shadowRadius: 8,
          elevation: 4,
        }}
      >
        <Pressable onPress={onClose} hitSlop={8} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={22} color={isDark ? darkColors.text.primary : colors.neutral[800]} />
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text variant="caption" color="secondary" style={{ marginBottom: 2 }}>
            {isPickup
              ? t('ride.pickup', { defaultValue: 'Punto de recogida' })
              : t('ride.dropoff', { defaultValue: 'Destino' })}
          </Text>
          {isGeocoding ? (
            <Animated.View
              style={{
                height: 14,
                backgroundColor: isDark ? darkColors.background.tertiary : colors.neutral[200],
                borderRadius: 4,
                width: '80%',
                opacity: shimmerOpacity,
              }}
            />
          ) : display?.line1 ? (
            // POI within a few meters → name on top (bold), address below (Bug 2b)
            <>
              <Text variant="bodySmall" numberOfLines={1} style={{ fontWeight: '700' }}>
                {display.line1}
              </Text>
              <Text variant="caption" color="secondary" numberOfLines={1}>
                {display.line2}
              </Text>
            </>
          ) : (
            <Text variant="bodySmall" numberOfLines={2}>
              {display?.line2 ?? t('ride.move_map', { defaultValue: 'Mueve el mapa para seleccionar' })}
            </Text>
          )}
        </View>
      </View>

      {/* Bottom confirm button */}
      <View
        style={{
          position: 'absolute',
          bottom: Platform.OS === 'ios' ? 40 : 24,
          left: 16,
          right: 16,
        }}
      >
        <Pressable
          onPress={handleConfirm}
          disabled={confirming}
          style={{
            backgroundColor: pinColor,
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 56,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.15,
            shadowRadius: 6,
            elevation: 3,
          }}
        >
          {confirming ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text
              variant="body"
              style={{
                color: '#fff',
                fontWeight: '700',
                fontSize: 16,
              }}
            >
              {t('ride.confirm_location', { defaultValue: 'Confirmar ubicación' })}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
