import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Pressable, Animated, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { reverseGeocode } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

const HAVANA_CENTER: [number, number] = [-82.3666, 23.1136];

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
  const { t } = useTranslation('rider');
  const [address, setAddress] = useState<string | null>(null);
  const [center, setCenter] = useState<GeoPoint>(
    initialLocation ?? { latitude: 23.1136, longitude: -82.3666 },
  );
  const [isGeocoding, setIsGeocoding] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [isGeocoding, shimmerAnim]);

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
      try {
        const result = await reverseGeocode(lat, lng);
        if (mountedRef.current) setAddress(result ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      } catch {
        if (mountedRef.current) setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      } finally {
        if (mountedRef.current) setIsGeocoding(false);
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

  const handleRegionChange = useCallback(
    (feature: any) => {
      const coords = feature?.geometry?.coordinates;
      if (!coords) return;
      const [lng, lat] = coords;
      setCenter({ latitude: lat, longitude: lng });
      geocodeCenter(lat, lng);
    },
    [geocodeCenter],
  );

  const handleConfirm = () => {
    if (!address) return;
    onConfirm(address, center);
  };

  const isPickup = mode === 'pickup';
  const pinColor = isPickup ? '#22c55e' : colors.brand.orange;

  if (!MapboxGL) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.neutral[100] }}>
        <Text variant="body" color="secondary">
          {t('map.unavailable', { defaultValue: 'Mapa no disponible' })}
        </Text>
        <Button title={t('common.close', { defaultValue: 'Cerrar' })} onPress={onClose} className="mt-4" />
      </View>
    );
  }

  const initialCenter: [number, number] = initialLocation
    ? [initialLocation.longitude, initialLocation.latitude]
    : HAVANA_CENTER;

  return (
    <View style={{ flex: 1 }}>
      {/* Map */}
      <MapboxGL.MapView
        style={{ flex: 1 }}
        styleURL="mapbox://styles/mapbox/streets-v12"
        attributionEnabled={false}
        logoEnabled={false}
        compassEnabled={false}
        onRegionDidChange={handleRegionChange}
      >
        <MapboxGL.Camera
          defaultSettings={{
            centerCoordinate: initialCenter,
            zoomLevel: 16,
          }}
        />
      </MapboxGL.MapView>

      {/* Static center pin — overlaid on map center */}
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
        {/* Pin shadow */}
        <View
          style={{
            width: 8,
            height: 4,
            borderRadius: 4,
            backgroundColor: 'rgba(0,0,0,0.2)',
            marginBottom: -2,
            transform: [{ translateY: 20 }],
          }}
        />
        {/* Pin */}
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
            <Ionicons
              name={isPickup ? 'radio-button-on' : 'flag'}
              size={14}
              color="#fff"
            />
          </View>
          {/* Pin stem */}
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
      </View>

      {/* Top address bar */}
      <View
        style={{
          position: 'absolute',
          top: Platform.OS === 'ios' ? 60 : 40,
          left: 16,
          right: 16,
          backgroundColor: '#fff',
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
          <Ionicons name="arrow-back" size={22} color={colors.neutral[800]} />
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
                backgroundColor: colors.neutral[200],
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
          disabled={!address || isGeocoding}
          style={{
            backgroundColor: !address || isGeocoding ? colors.neutral[300] : pinColor,
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
