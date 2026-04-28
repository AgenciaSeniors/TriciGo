import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, Pressable, Animated, Platform, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

// BUG-281: branded dropoff pin asset. The image is a white silhouette on
// a transparent background — RN tints it via the Image `tintColor` style
// so we can apply the brand orange consistently across light/dark themes.
const DROPOFF_PIN_ASSET = require('../../assets/markers/dropoff-pin.png');
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { reverseGeocode, MAP_STYLE_LIGHT } from '@tricigo/utils';
import type { GeoPoint, ViewportPoi } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import { getMapFallbackCoordLngLat } from '@/config/demo';
import { useViewportPois } from '@/hooks/useViewportPois';

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

/* POI category colors (same as RideMapView) */
const POI_COLORS: Record<string, string> = {
  restaurant: '#E53935', cafe: '#E53935', bar: '#E53935', fast_food: '#E53935', bakery: '#E53935',
  hotel: '#1E88E5', guest_house: '#1E88E5', hostel: '#1E88E5',
  hospital: '#43A047', clinic: '#43A047', pharmacy: '#43A047', doctors: '#43A047',
  supermarket: '#FB8C00', convenience: '#FB8C00', marketplace: '#FB8C00',
  school: '#8E24AA', university: '#8E24AA',
  bank: '#546E7A', post_office: '#546E7A', police: '#546E7A',
  park: '#2E7D32', beach: '#2E7D32', museum: '#2E7D32', monument: '#2E7D32',
  fuel: '#FF6F00', bus_station: '#FF6F00',
};

function poisToGeoJSON(pois: ViewportPoi[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pois.map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      properties: { id: p.id, name: p.name, color: POI_COLORS[p.subcategory] || '#78909C' },
    })),
  };
}

interface ConfirmLocationScreenProps {
  mode: 'pickup' | 'dropoff';
  initialLocation?: GeoPoint | null;
  onConfirm: (address: string, location: GeoPoint) => void;
  onClose: () => void;
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
  const [address, setAddress] = useState<string | null>(null);
  const centerRef = useRef<GeoPoint>(initialLocation ?? { latitude: 23.1136, longitude: -82.3666 });
  const [isGeocoding, setIsGeocoding] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapRef = useRef<any>(null);

  // POIs
  const { pois, onCameraChanged: onPoiCameraChanged } = useViewportPois();
  const poiGeoJSON = useMemo(() => {
    if (!pois || pois.length === 0) return null;
    return poisToGeoJSON(pois);
  }, [pois]);

  const handleCameraForPois = useCallback((event: any) => {
    try {
      const { properties } = event;
      const zoom = properties?.zoomLevel ?? 13;
      const visibleBounds = properties?.visibleBounds;
      if (visibleBounds && visibleBounds.length === 2) {
        const [ne, sw] = visibleBounds;
        onPoiCameraChanged({ minLng: sw[0], minLat: sw[1], maxLng: ne[0], maxLat: ne[1] }, zoom);
      }
    } catch {}
  }, [onPoiCameraChanged]);

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
      setAddress(null); // Show shimmer

      // Retry up to 3 times
      let result: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!mountedRef.current) break;
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
        try {
          result = await reverseGeocode(lat, lng);
          if (result) break;
        } catch { /* continue to next attempt */ }
      }

      if (mountedRef.current) {
        setAddress(result ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
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

  const handleConfirm = () => {
    const finalAddress = address || 'Ubicación seleccionada en el mapa';
    onConfirm(finalAddress, centerRef.current);
  };

  const isPickup = mode === 'pickup';
  const pinColor = isPickup ? '#22c55e' : colors.brand.orange;

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

  // BUG-282 — pull a cached last-known position as a fallback before the
  // demo-city/Havana fallback. This catches the edge case where the user
  // opens the picker on first launch before the GPS effect populates
  // draft.pickup. Cache reads asynchronously, so we use it via state and
  // remount the Camera (key prop below) when it resolves.
  const [cachedFallback, setCachedFallback] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (initialLocation) return; // initialLocation is already valid, no need
    AsyncStorage.getItem('last_known_location').then((raw) => {
      if (!raw) return;
      try {
        const { latitude, longitude } = JSON.parse(raw);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          setCachedFallback([longitude, latitude]);
        }
      } catch { /* malformed */ }
    }).catch(() => {});
  }, [initialLocation]);

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
        onMapIdle={(event: any) => { handleMapIdle(); handleCameraForPois(event); }}
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

        {/* POI layers */}
        {poiGeoJSON && (
          <MapboxGL.ShapeSource id="confirm-pois" shape={poiGeoJSON} cluster clusterMaxZoomLevel={14} clusterRadius={40}>
            <MapboxGL.CircleLayer
              id="confirm-poi-clusters"
              filter={['has', 'point_count']}
              style={{ circleColor: ['step', ['get', 'point_count'], '#51bbd6', 50, '#f1f075', 200, '#f28cb1'], circleRadius: ['step', ['get', 'point_count'], 12, 50, 16, 200, 20], circleStrokeWidth: 1.5, circleStrokeColor: 'rgba(255,255,255,0.6)' }}
            />
            <MapboxGL.SymbolLayer
              id="confirm-poi-cluster-count"
              filter={['has', 'point_count']}
              style={{ textField: ['get', 'point_count_abbreviated'], textSize: 10, textColor: '#333' }}
            />
            <MapboxGL.CircleLayer
              id="confirm-poi-unclustered"
              filter={['!', ['has', 'point_count']]}
              style={{ circleColor: ['get', 'color'], circleRadius: ['interpolate', ['linear'], ['zoom'], 12, 2, 15, 4, 18, 7], circleStrokeWidth: 1, circleStrokeColor: 'rgba(255,255,255,0.9)' }}
            />
            <MapboxGL.SymbolLayer
              id="confirm-poi-labels"
              filter={['!', ['has', 'point_count']]}
              minZoomLevel={14}
              style={{ textField: ['get', 'name'], textSize: ['interpolate', ['linear'], ['zoom'], 14, 8, 16, 10], textOffset: [0, 1.0], textAnchor: 'top', textMaxWidth: 7, textOptional: true, textAllowOverlap: false, textColor: '#555', textHaloColor: 'rgba(255,255,255,0.95)', textHaloWidth: 1 }}
            />
          </MapboxGL.ShapeSource>
        )}
      </MapboxGL.MapView>

      {/* BUG-281 — Static center pin overlaid on map center.
         Pickup: small green disc (universal "you are here" semantic).
         Dropoff: branded TriciGo pin in brand-orange — the asset is the
         app's adaptive-icon foreground (white pin silhouette on transparent
         background) tinted via Image.tintColor so the brand color stays
         consistent without shipping a second PNG. */}
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
        {/* Drop shadow under the pin tip — anchors the pin to the map */}
        <View
          style={{
            width: 8,
            height: 4,
            borderRadius: 4,
            backgroundColor: 'rgba(0,0,0,0.2)',
            marginBottom: -2,
            transform: [{ translateY: isPickup ? 20 : 22 }],
          }}
        />
        {isPickup ? (
          /* Pickup — kept simple/green for "you" semantic */
          <View style={{ alignItems: 'center' }}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: pinColor,
                justifyContent: 'center',
                alignItems: 'center',
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.25,
                shadowRadius: 4,
                elevation: 4,
              }}
            >
              <Ionicons name="radio-button-on" size={14} color="#fff" />
            </View>
            <View
              style={{
                width: 3,
                height: 12,
                backgroundColor: pinColor,
                borderBottomLeftRadius: 2,
                borderBottomRightRadius: 2,
              }}
            />
          </View>
        ) : (
          /* Dropoff — branded TriciGo pin.
             BUG-285 — wrapper needs explicit width/height to render. The
             ConfirmLocationScreen overlay is `position: absolute` with
             centered alignment, so a 0×0 wrapper still renders nothing.
             Same fix as the in-trip dropoff markers. */
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
              source={DROPOFF_PIN_ASSET}
              style={{
                width: 44,
                height: 44,
                tintColor: colors.brand.orange,
              }}
              resizeMode="contain"
              accessibilityLabel="Pin de destino TriciGo"
            />
          </View>
        )}
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
          ) : (
            <Text variant="bodySmall" numberOfLines={2}>
              {address ?? t('ride.move_map', { defaultValue: 'Mueve el mapa para seleccionar' })}
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
          disabled={isGeocoding || !address}
          style={{
            backgroundColor: isGeocoding ? (isDark ? darkColors.background.tertiary : colors.neutral[300]) : pinColor,
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.15,
            shadowRadius: 6,
            elevation: 3,
          }}
        >
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
        </Pressable>
      </View>
    </View>
  );
}
