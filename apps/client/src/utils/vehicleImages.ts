// ============================================================
// TriciGo — Vehicle Image Mappings
// Maps ServiceTypeSlug → image assets for selection and markers
// ============================================================

import type { ImageSourcePropType } from 'react-native';
import type { ServiceTypeSlug } from '@tricigo/types';

/** Large images for service type selection UI (64×64) */
export const vehicleSelectionImages: Record<ServiceTypeSlug, ImageSourcePropType> = {
  triciclo_basico: require('../../assets/vehicles/selection/triciclo.png'),
  triciclo_premium: require('../../assets/vehicles/selection/triciclo.png'),
  moto_standard: require('../../assets/vehicles/selection/moto.png'),
  auto_standard: require('../../assets/vehicles/selection/auto.png'),
  mensajeria: require('../../assets/vehicles/selection/mensajeria.png'),
};

/** Small images for map markers */
export const vehicleMarkerImages: Record<ServiceTypeSlug, ImageSourcePropType> = {
  triciclo_basico: require('../../assets/vehicles/markers/triciclo.png'),
  triciclo_premium: require('../../assets/vehicles/markers/triciclo.png'),
  moto_standard: require('../../assets/vehicles/markers/moto.png'),
  auto_standard: require('../../assets/vehicles/markers/auto.png'),
  mensajeria: require('../../assets/vehicles/markers/moto.png'),
};
