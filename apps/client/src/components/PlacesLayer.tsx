import React from 'react';
import { getMapboxGL } from '@/lib/mapbox';
import { POI_LAYER_ID, POI_SOURCE_ID, POI_SOURCE_LAYER, poiFilter, poiIconImage } from '@tricigo/utils';

/**
 * Places drawn over the style's own vector source — maki icon + name.
 *
 * Mount ONLY after the map's style finishes loading (gate on
 * onDidFinishLoadingStyle → styleReady): a style layer mounted during the
 * load attaches but loses its paint to a race and draws with Mapbox
 * DEFAULTS — i.e. invisibly. That race cost a whole night to find; the
 * gate is load-bearing, not defensive decoration.
 *
 * The style's own `poi-label` layer is hidden while this is mounted: it
 * writes names for the famous handful and would double-label them on top
 * of ours. Unmounting restores it only for THIS MapView instance, which
 * is exactly the scope we want.
 */
export function PlacesLayer({ isDark }: { isDark: boolean }) {
  const MapboxGL = getMapboxGL();
  if (!MapboxGL) return null;
  return (
    <>
      <MapboxGL.SymbolLayer id="poi-label" existing style={{ visibility: 'none' }} />
      <MapboxGL.SymbolLayer
        id={POI_LAYER_ID}
        sourceID={POI_SOURCE_ID}
        sourceLayerID={POI_SOURCE_LAYER}
        aboveLayerID="poi-label"
        minZoomLevel={13}
        filter={poiFilter as never}
        style={{
          iconImage: poiIconImage as never,
          iconSize: 1,
          iconAllowOverlap: false,
          iconOpacity: 0.9,
          iconAnchor: 'bottom',
          // Name under the icon, in Spanish where the tile carries it.
          // textOptional keeps the icon when the label loses a collision,
          // so dense blocks degrade to icons instead of vanishing.
          textField: ['coalesce', ['get', 'name_es'], ['get', 'name']] as never,
          textSize: 11,
          textFont: ['DIN Pro Medium', 'Arial Unicode MS Regular'] as never,
          textColor: isDark ? '#a8b0bb' : '#5b6470',
          textHaloColor: isDark ? '#1a1a24' : '#ffffff',
          textHaloWidth: 1,
          textAnchor: 'top',
          textOffset: [0, 0.2] as never,
          textOptional: true,
          textMaxWidth: 8,
        }}
      />
    </>
  );
}
