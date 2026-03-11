import React, { useRef, useEffect } from 'react';
import { View, Text } from 'react-native';

let MapView: any;
let Marker: any;
try {
  const Maps = require('react-native-maps');
  MapView = Maps.default;
  Marker = Maps.Marker;
} catch {
  MapView = null;
  Marker = null;
}

import { colors } from '@tricigo/theme';

interface GeoPoint {
  latitude: number;
  longitude: number;
}

interface RideMapViewProps {
  pickupLocation?: GeoPoint | null;
  dropoffLocation?: GeoPoint | null;
  driverLocation?: GeoPoint | null;
  height?: number;
}

const HAVANA_CENTER = { latitude: 23.1136, longitude: -82.3666 };

export function RideMapView({
  pickupLocation,
  dropoffLocation,
  driverLocation,
  height = 200,
}: RideMapViewProps) {
  const mapRef = useRef<any>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    const markers: string[] = [];
    if (pickupLocation) markers.push('pickup');
    if (dropoffLocation) markers.push('dropoff');
    if (driverLocation) markers.push('driver');
    if (markers.length > 0) {
      setTimeout(() => {
        mapRef.current?.fitToSuppliedMarkers(markers, {
          edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
          animated: true,
        });
      }, 500);
    }
  }, [pickupLocation, dropoffLocation, driverLocation]);

  if (!MapView) {
    return (
      <View
        style={{ height, backgroundColor: colors.neutral[100], justifyContent: 'center', alignItems: 'center', borderRadius: 12 }}
      >
        <Text style={{ color: colors.neutral[500] }}>Mapa no disponible</Text>
      </View>
    );
  }

  return (
    <View style={{ height, borderRadius: 12, overflow: 'hidden' }}>
      <MapView
        ref={mapRef}
        style={{ flex: 1 }}
        initialRegion={{
          ...HAVANA_CENTER,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }}
      >
        {pickupLocation && (
          <Marker
            identifier="pickup"
            coordinate={pickupLocation}
            pinColor={colors.success.DEFAULT}
            title="Recogida"
          />
        )}
        {dropoffLocation && (
          <Marker
            identifier="dropoff"
            coordinate={dropoffLocation}
            pinColor={colors.error.DEFAULT}
            title="Destino"
          />
        )}
        {driverLocation && (
          <Marker
            identifier="driver"
            coordinate={driverLocation}
            pinColor={colors.info.DEFAULT}
            title="Conductor"
          />
        )}
      </MapView>
    </View>
  );
}
