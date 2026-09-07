import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Pressable, Animated, Platform, Image, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { reverseGeocode, reverseGeocodeStructured, haversineDistance, findNearestPreset, MAP_STYLE_LIGHT, MAP_STYLE_DARK, MAP_COLORS, MARKER, POI_LAYER_ID, poiNameFromFeature, triggerHaptic, triggerSelection, pinConfidence, pickerZoomFor } from '@tricigo/utils';
import { PlacesLayer } from './PlacesLayer';
import type { GeoPoint, StructuredAddress } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors, darkColors } from '@tricigo/theme';
import { useThemeStore } from '@/stores/theme.store';
import { getMapFallbackCoordLngLat, getMapFallbackLatLng } from '@/config/demo';
import { getMapboxGL, ensureMapboxToken } from '@/lib/mapbox';
import { useTwoStageUserCenter } from '@/lib/userLocation';
import { useLocateMe } from '@/hooks/useLocateMe';

// Token before any MapView mounts — see the note in lib/mapbox.ts.
ensureMapboxToken();

// Map fallback; Havana in prod, configurable for demo (see config/demo.ts).
const HAVANA_CENTER: [number, number] = getMapFallbackCoordLngLat();

interface ConfirmLocationScreenProps {
  mode: 'pickup' | 'dropoff';
  initialLocation?: GeoPoint | null;
  /** 00537 pin confirmation: the address text the user picked in search.
   *  When the pin is confirmed without moving (< ~20 m from
   *  initialLocation), this richer label is kept instead of replacing it
   *  with the reverse geocode of the same spot. */
  initialAddress?: string | null;
  /** 00537: render the "¿El destino es aquí? Ajústalo si no" caption —
   *  used when the screen opens to CONFIRM a geocoded search result
   *  (incident b428022b) rather than to pick a point from scratch. */
  confirmPrompt?: boolean;
  /** The point being confirmed came from a ZONE search result (neighbourhood
   *  / municipality centroid, see `isZoneLevelResult`): the caption asks to
   *  move the pin to the exact spot instead of "¿El destino es aquí?". */
  confirmHint?: 'zone' | null;
  /** Opened to adjust/confirm an EXISTING point: open close (zoom 17) so the
   *  street under the tip is readable. From scratch the picker opens wider. */
  seeded?: boolean;
  /** The other end of the trip, drawn static for orientation while picking. */
  counterpart?: { location: GeoPoint; mode: 'pickup' | 'dropoff' } | null;
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
  initialAddress,
  confirmPrompt,
  confirmHint,
  seeded,
  counterpart,
  onConfirm,
  onClose,
}: ConfirmLocationScreenProps) {
  ensureMapboxToken();
  const MapboxGL = getMapboxGL();
  const { t } = useTranslation('rider');
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  const isDark = resolvedScheme === 'dark';
  const insets = useSafeAreaInsets();
  // Two-line address display: line1 = POI name (when one sits within a few
  // meters), line2 = the street/locality address. line1 omitted → single line.
  const [display, setDisplay] = useState<{ line1?: string; line2: string } | null>(null);
  // Which reverse-geocode layer produced `display`. Drives the confidence
  // caption: a pin with no street within 200 m used to render
  // "Cerro, La Habana" exactly like a real address — 13 % of prod dropoffs.
  const [source, setSource] = useState<StructuredAddress['source'] | null>(null);
  const centerRef = useRef<GeoPoint>(initialLocation ?? getMapFallbackLatLng());
  const [isGeocoding, setIsGeocoding] = useState(false);
  // Confirm button is decoupled from geocoding — see handleConfirm.
  const [confirming, setConfirming] = useState(false);
  // Same load-race gate as RideMapView: style layers mounted before the
  // style finishes loading keep their attachment but lose their paint.
  const [styleReady, setStyleReady] = useState(false);
  const styleURL = isDark ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;
  useEffect(() => {
    setStyleReady(false);
  }, [styleURL]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  // Pin sits at the visual centre of the map; its pixel position is needed
  // to ask the map which rendered place (if any) the pin is standing on.
  const mapLayoutRef = useRef<{ w: number; h: number } | null>(null);

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

  // Pin "lift": rises while the map moves under it and drops when it settles,
  // so the gesture reads as picking the pin up rather than sliding a map.
  // onCameraChanged fires per frame — the ref keeps it to one animation per
  // gesture.
  const liftAnim = useRef(new Animated.Value(0)).current;
  const liftedRef = useRef(false);
  const setLifted = useCallback((lifted: boolean) => {
    if (liftedRef.current === lifted) return;
    liftedRef.current = lifted;
    Animated.timing(liftAnim, { toValue: lifted ? 1 : 0, duration: 120, useNativeDriver: true }).start();
  }, [liftAnim]);
  const pinLift = liftAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
  const shadowScale = liftAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.6] });
  const shadowOpacity = liftAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] });

  // Reverse geocode the center point
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const geocodeCenter = useCallback((lat: number, lng: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      setIsGeocoding(true);
      setDisplay(null); // Show shimmer
      setSource(null);

      // The name the rider can SEE wins. The map draws places from the
      // Mapbox tiles; the reverse-geocode POI comes from cuba_pois — two
      // different datasets. Standing the pin on a place the map itself is
      // labeling while the address bar names some other (possibly defunct)
      // venue from the DB reads as a bug, and the user reported it as one.
      let visiblePoi: string | null = null;
      try {
        const lay = mapLayoutRef.current;
        if (lay) {
          const half = 28;
          const hits = await mapRef.current?.queryRenderedFeaturesInRect(
            [lay.h / 2 - half, lay.w / 2 - half, lay.h / 2 + half, lay.w / 2 + half],
            undefined,
            [POI_LAYER_ID],
          );
          let bestD = Infinity;
          for (const f of hits?.features ?? []) {
            const c = (f?.geometry as { coordinates?: number[] } | undefined)?.coordinates;
            const name = poiNameFromFeature(f);
            const cLng = c?.[0];
            const cLat = c?.[1];
            if (!name || typeof cLng !== 'number' || typeof cLat !== 'number' || !Number.isFinite(cLng) || !Number.isFinite(cLat)) continue;
            const d = haversineDistance({ latitude: lat, longitude: lng }, { latitude: cLat, longitude: cLng });
            if (d <= 25 && d < bestD) { bestD = d; visiblePoi = name; }
          }
        }
      } catch { /* no visible place is a normal outcome */ }

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
        {
          const d = toDisplay(result, lat, lng);
          if (visiblePoi) d.line1 = visiblePoi;
          setDisplay(d);
          setSource(result?.source ?? null);
        }
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
    setLifted(false);
    try {
      if (mapRef.current?.getCenter) {
        const center = await mapRef.current.getCenter();
        if (center && Array.isArray(center) && center.length === 2) {
          const [lng, lat] = center;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Capture before overwriting: comparing against centerRef after
            // the assignment would always measure zero movement.
            const previous = centerRef.current;
            centerRef.current = { latitude: lat, longitude: lng };
            // Only when the pin actually landed somewhere else. A map that
            // settles a metre after the finger lifts should stay silent.
            if (haversineDistance(previous, { latitude: lat, longitude: lng }) > 15) {
              void triggerSelection();
            }
            geocodeCenter(lat, lng);
            return;
          }
        }
      }
    } catch { /* fallback below */ }
    // Fallback: use whatever is in centerRef (initial location)
    geocodeCenter(centerRef.current.latitude, centerRef.current.longitude);
  }, [geocodeCenter, setLifted]);

  // "Center on my location" FAB. Flies the camera to the user's current
  // position; the existing onMapIdle → getCenter() → geocode path then moves
  // the center pin and refreshes the address bar, exactly like dragging the
  // map. We don't touch centerRef here — the camera move drives everything.
  const { locate: handleGoToMyLocation, isLocating } = useLocateMe(
    useCallback((lng: number, lat: number) => {
      cameraRef.current?.setCamera({
        centerCoordinate: [lng, lat],
        zoomLevel: 16,
        animationDuration: 600,
        animationMode: 'flyTo',
      });
    }, []),
  );

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
    void triggerHaptic('light');
    // Every exit path clears the spinner. The parent usually unmounts this
    // screen right after onConfirm, but when it doesn't (or onConfirm
    // throws) the button used to stay stuck spinning forever.
    try {
      const center = centerRef.current;
      // 00537 pin confirmation: confirming without moving the pin keeps the
      // address the user PICKED in search ("Calle 3ra e/ 4 y 2, Vedado") —
      // richer than the reverse geocode of the exact same coordinate. Moving
      // the pin means the label no longer applies → reverse geocode as usual.
      if (
        initialAddress &&
        initialLocation &&
        haversineDistance(center, initialLocation) < 20
      ) {
        onConfirm(initialAddress, center);
        return;
      }
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
      // Incident cd09ba9f: on slow networks the geocode misses the 3 s cap and
      // the old fallback ('Ubicación seleccionada en el mapa') reached the
      // driver's offer card, which is useless for deciding. The label must
      // always SAY something: nearest local preset ("Cerca de Vedado" — pure
      // local math, no network) before falling back to raw coordinates. Both
      // fallback forms are sentinels the server-side backstop (00539) upgrades
      // with real intersection data at ride creation.
      const coordsRe = /^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/;
      if (!finalAddress || coordsRe.test(finalAddress)) {
        const preset = findNearestPreset(center, 5000);
        finalAddress = preset
          ? `Cerca de ${preset.label}`
          : `${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`;
      }
      onConfirm(finalAddress, center);
    } finally {
      if (mountedRef.current) setConfirming(false);
    }
  };

  const isPickup = mode === 'pickup';
  const pinColor = isPickup ? MAP_COLORS.pickup : colors.brand.orange;
  const confidence = pinConfidence(source);
  const showConfidence = !isGeocoding && !!display;

  // BUG-282 (revised) — cache-then-GPS centering, skipped entirely when the
  // caller already handed us a valid initialLocation.
  const cachedFallback = useTwoStageUserCenter(!initialLocation);

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
        styleURL={styleURL}
        onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) => {
          mapLayoutRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
        }}
        onDidFinishLoadingStyle={() => setStyleReady(true)}
        onPress={async (feature: any) => {
          const x = feature?.properties?.screenPointX;
          const y = feature?.properties?.screenPointY;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          try {
            // Tap a place → fly the pin there. The camera move ends in
            // onMapIdle, which reverse-geocodes like any hand drag — the
            // address still comes from the geocoder, never the tile label.
            const half = 22;
            const hits = await mapRef.current?.queryRenderedFeaturesInRect(
              [y - half, x - half, y + half, x + half],
              undefined,
              [POI_LAYER_ID],
            );
            const coords = (hits?.features?.[0]?.geometry as { coordinates?: number[] } | undefined)?.coordinates;
            if (!Array.isArray(coords)) return;
            const [lng, lat] = coords;
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            void triggerSelection();
            cameraRef.current?.setCamera({ centerCoordinate: [lng, lat], animationDuration: 450 });
          } catch {
            /* a missed tap is just a missed tap */
          }
        }}
        attributionEnabled={false}
        logoEnabled={false}
        // Natural map orientation in the pin picker: let the user rotate AND
        // tilt the map with two fingers (was hard-disabled). The address is
        // derived from getCenter() (the screen-center pixel), which is
        // rotation-invariant and pitch-consistent, and the static pin tip sits
        // at that same center — so orienting the map never shifts the picked
        // point. The compass appears only when rotated (fadeWhenNorth) and
        // tapping it snaps the bearing back to north; placed under the top
        // address bar so it doesn't collide with it.
        compassEnabled={true}
        compassFadeWhenNorth={true}
        compassViewPosition={1}
        compassViewMargins={{ x: 16, y: insets.top + 80 }}
        scaleBarEnabled={false}
        scrollEnabled={true}
        zoomEnabled={true}
        pitchEnabled={true}
        rotateEnabled={true}
        onCameraChanged={() => setLifted(true)}
        onMapIdle={handleMapIdle}
      >
        {/* BUG-282 — key forces Camera remount when initialCenter resolves
            asynchronously (cachedFallback). defaultSettings only applies
            on first mount, so without the key change the camera would
            stay glued to HAVANA_CENTER for the entire picker session. */}
        <MapboxGL.Camera
          ref={cameraRef}
          key={`cam-${initialCenter[0].toFixed(4)},${initialCenter[1].toFixed(4)}`}
          defaultSettings={{
            centerCoordinate: initialCenter,
            zoomLevel: pickerZoomFor(!!seeded),
          }}
        />

        {/* The other end of the trip, for orientation: picking the dropoff
            while the pickup is off-screen is picking blind. Static, never
            interactive — the only pin that moves here is the center one. */}
        {counterpart
          && Number.isFinite(counterpart.location.latitude)
          && Number.isFinite(counterpart.location.longitude) && (
          <MapboxGL.MarkerView
            id="counterpart"
            coordinate={[counterpart.location.longitude, counterpart.location.latitude]}
            anchor={counterpart.mode === 'dropoff' ? { x: 0.5, y: 1 } : { x: 0.5, y: 0.5 }}
            allowOverlap
          >
            <View pointerEvents="none" style={{ opacity: 0.85 }}>
              {counterpart.mode === 'dropoff' ? (
                <Image
                  source={ROUTE_PIN_ASSET}
                  style={{ width: MARKER.dropoffPin.size * 0.8, height: MARKER.dropoffPin.size * 0.8, tintColor: colors.brand.orange }}
                  resizeMode="contain"
                  accessibilityLabel={t('map.dropoff_marker')}
                />
              ) : (
                <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: MAP_COLORS.pickup, borderWidth: 3, borderColor: 'white' }} />
              )}
            </View>
          </MapboxGL.MarkerView>
        )}

        {/* Orientation while dragging the map under the fixed pin: without
            this the rider has no anchor for where they actually are. */}
        <MapboxGL.LocationPuck visible puckBearing="heading" puckBearingEnabled />
        {styleReady && <PlacesLayer isDark={isDark} />}
      </MapboxGL.MapView>

      {/* Style-load veil — see RideMapView: masks the staggered repaint of
          a style swap behind one clean theme-colored transition. */}
      {!styleReady && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: isDark ? '#0f1116' : '#f4f4f5' }}
        />
      )}

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
        <Animated.View
          style={{
            width: 10,
            height: 4,
            borderRadius: 4,
            backgroundColor: 'rgba(0,0,0,0.22)',
            marginBottom: -2,
            opacity: shadowOpacity,
            transform: [{ translateY: 22 }, { scaleX: shadowScale }],
          }}
        />
        <Animated.View
          style={{
            width: MARKER.dropoffPin.size,
            height: MARKER.dropoffPin.size,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.3,
            shadowRadius: 4,
            elevation: 5,
            transform: [{ translateY: pinLift }],
          }}
        >
          <Image
            source={ROUTE_PIN_ASSET}
            style={{
              width: MARKER.dropoffPin.size,
              height: MARKER.dropoffPin.size,
              tintColor: pinColor,
            }}
            resizeMode="contain"
            accessibilityLabel={isPickup ? t('map.pickup_marker') : t('map.dropoff_marker')}
          />
        </Animated.View>
      </View>

      {/* Top address bar */}
      <View
        style={{
          position: 'absolute',
          top: insets.top + 12,
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
            {confirmHint === 'zone'
              ? t('ride.zone_adjust_prompt', { defaultValue: 'Es una zona amplia — ajusta el pin al lugar exacto' })
              : confirmPrompt
                ? isPickup
                  ? t('ride.confirm_pickup_pin_prompt', { defaultValue: '¿Te recogemos aquí? Ajústalo si no' })
                  : t('ride.confirm_pin_prompt', { defaultValue: '¿El destino es aquí? Ajústalo si no' })
                : isPickup
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
              {display?.line2 ?? t('ride.move_map')}
            </Text>
          )}
          {/* Confidence — the geocoder's own verdict on the point under the
              tip. `near` (a street within 200 m) says nothing: that is the
              normal case. */}
          {showConfidence && confidence === 'exact' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
              <Ionicons name="checkmark-circle" size={12} color={MAP_COLORS.pickup} />
              <Text variant="caption" style={{ color: MAP_COLORS.pickup, marginLeft: 4 }}>
                {t('ride.pin_exact', { defaultValue: 'Dirección exacta' })}
              </Text>
            </View>
          )}
          {showConfidence && confidence === 'none' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
              <Ionicons name="alert-circle" size={12} color={colors.brand.orange} />
              <Text variant="caption" numberOfLines={2} style={{ color: colors.brand.orange, marginLeft: 4, flex: 1 }}>
                {t('ride.pin_no_street', { defaultValue: 'Sin calle cercana — acerca el pin a una calle' })}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* "Center on my location" FAB — sits just above the confirm button,
         bottom-right (mirrors the recenter FAB in RideMapView). Tapping it
         flies the camera to the user's GPS; onMapIdle then moves the pin and
         refreshes the address, so the picked point becomes their location. */}
      <Pressable
        onPress={handleGoToMyLocation}
        disabled={isLocating}
        accessibilityRole="button"
        accessibilityLabel={t('ride.center_on_me', { defaultValue: 'Centrar en mi ubicación' })}
        hitSlop={8}
        style={{
          position: 'absolute',
          right: 16,
          bottom: (Platform.OS === 'ios' ? 40 : 24) + 56 + 16,
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: isDark ? darkColors.card : '#fff',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.18,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        {isLocating ? (
          <ActivityIndicator size="small" color={colors.brand.orange} />
        ) : (
          <Ionicons name="locate" size={22} color={colors.brand.orange} />
        )}
      </Pressable>

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
              {showConfidence && confidence === 'none'
                ? t('ride.confirm_anyway', { defaultValue: 'Confirmar de todos modos' })
                : t('ride.confirm_location')}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
