/**
 * Expo config plugin — opt-out temporal de las restricciones de orientación y
 * redimensionamiento que Android 16 (API 36) impone en pantallas grandes.
 *
 * IDÉNTICO a apps/client/plugins/with-large-screen-compat.js — duplicado porque los
 * config plugins de Expo son per-app (cada app.json registra su propia carpeta
 * plugins/), no compartibles vía packages del monorepo. El header con la causa raíz
 * completa y las decisiones de implementación vive en la copia del cliente; leer esa
 * primero. Mantenimiento: al actualizar uno, sincronizar el otro.
 *
 * Resumen: desde targetSdkVersion 36, Android 16 IGNORA `android:screenOrientation`
 * y `android:resizeableActivity` en displays con smallest-width >= 600dp (tablets,
 * plegables abiertos, ChromeOS, escritorio). Esta property le pide al framework que
 * siga respetando el `orientation: "portrait"` declarado en app.json.
 *
 * El driver es MÁS sensible que el cliente: la pantalla de viaje activo combina mapa
 * full-bleed (@rnmapbox/maps) + bottom sheet + botones de acción, con overlays
 * posicionados a mano sobre insets.top. En landscape el sheet taparía el mapa entero.
 *
 * Por qué es seguro: sólo afecta displays >= 600dp. En teléfonos (< 600dp, el 100%
 * real del parque en Cuba) el manifest cambia pero el comportamiento es idéntico.
 *
 * ⚠️ TEMPORAL: Google deja de honrar esta property al targetear API 37. Antes de ese
 * bump hay que hacer el trabajo real (layouts adaptativos, o aceptar landscape).
 *
 * Docs:
 *   https://developer.android.com/about/versions/16/behavior-changes-16#adaptive-layouts
 */

const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const PROPERTY_NAME =
  'android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY';

function setRestrictedResizabilityProperty(androidManifest) {
  // Falla ruidoso en prebuild antes que shipear un APK sin el opt-out.
  const mainApplication =
    AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);

  // El template de Expo no trae <property>, así que la key puede no existir.
  // Tampoco asumimos que sea un array si otro plugin la creó de otra forma.
  if (!Array.isArray(mainApplication.property)) {
    mainApplication.property = [];
  }

  // Idempotency — el sentinel es el propio android:name. El optional chaining
  // evita explotar si otro plugin metió una entry sin `$` o sin `android:name`.
  const existing = mainApplication.property.find(
    (entry) => entry?.$?.['android:name'] === PROPERTY_NAME,
  );

  if (existing) {
    existing.$['android:value'] = 'true';
  } else {
    mainApplication.property.push({
      $: {
        'android:name': PROPERTY_NAME,
        'android:value': 'true',
      },
    });
  }

  return androidManifest;
}

module.exports = function withLargeScreenCompat(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults = setRestrictedResizabilityProperty(config.modResults);
    return config;
  });
};
