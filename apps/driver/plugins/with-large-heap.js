/**
 * Expo config plugin — set `android:largeHeap="true"` on <application>.
 *
 * IDÉNTICO a apps/client/plugins/with-large-heap.js — duplicado porque los
 * config plugins de Expo son per-app (cada app.json registra su propia carpeta
 * plugins/), no compartibles vía packages del monorepo. Mantenimiento: al
 * actualizar uno, sincronizar el otro.
 *
 * Por qué: los flujos de foto (selfie, foto del vehículo, documentos, avatar)
 * decodifican bitmaps de cámara vía expo-image-manipulator, y las pantallas
 * principales corren @rnmapbox/maps — ambas cargas de memoria nativas grandes.
 * En Android de poca RAM el heap default (~192-256 MB) se agota decodificando
 * una foto de 12+ MP y el proceso muere por OOM sin pasar por JS ("la app se
 * bloquea y regresa atrás", inatrapable por try/catch o Sentry). largeHeap
 * sube el límite por proceso (típicamente a 512 MB) y le da margen real a la
 * decodificación + el mapa coexistiendo.
 *
 * Trade-off conocido: GCs algo más largos y el sistema mata la app en
 * background con más agrado. Aceptable: TriciGo es cámara + mapa, el perfil
 * clásico de app que lo usa (la mitigación principal sigue siendo comprimir
 * ANTES de decodificar — resizeImageForCrop/compressDocument; esto es el
 * cinturón de seguridad para los picos inevitables).
 *
 * expo-build-properties 1.0.9 no expone largeHeap, por eso el plugin custom.
 * withAndroidManifest re-escribe el atributo en cada prebuild → idempotente.
 */

const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withLargeHeap(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults?.manifest?.application?.[0];
    if (application) {
      application.$['android:largeHeap'] = 'true';
    }
    return cfg;
  });
};
