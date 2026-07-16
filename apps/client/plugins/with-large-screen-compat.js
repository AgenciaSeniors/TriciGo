/**
 * Expo config plugin — opt-out temporal de las restricciones de orientación y
 * redimensionamiento que Android 16 (API 36) impone en pantallas grandes.
 *
 * Contexto (2026-07-16): Google Play Console avisa "Quita las restricciones de
 * redimensionamiento y orientación de tu aplicación para que sea compatible con
 * dispositivos de pantalla grande". El aviso es informativo y NO bloquea la
 * publicación, pero se vuelve real al subir targetSdkVersion 35 → 36 (obligatorio
 * para publicar updates desde el 31/08/2026).
 *
 * Causa raíz:
 *   - Desde targetSdkVersion 36, Android 16 IGNORA `android:screenOrientation`,
 *     `android:resizeableActivity`, `android:minAspectRatio` y `android:maxAspectRatio`
 *     en cualquier display con smallest-width >= 600dp (tablets, plegables abiertos,
 *     ChromeOS, modo escritorio, ventanas freeform). La activity se fuerza a
 *     resizable + orientación libre.
 *   - TriciGo declara `orientation: "portrait"` (app.json), que Expo traduce a
 *     `android:screenOrientation="portrait"` en MainActivity. Con targetSdk 36 ese
 *     lock deja de aplicarse en >= 600dp → el mapa (@rnmapbox/maps) y los bottom
 *     sheets se re-layoutean en landscape, un modo que NUNCA fue diseñado ni
 *     QA-eado en este producto.
 *
 * Fix:
 *   Declarar la property de compatibilidad en <application>. Le pide al framework
 *   que siga respetando las restricciones declaradas — o sea, mantiene el portrait
 *   forzado también en >= 600dp:
 *
 *     <property
 *       android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"
 *       android:value="true" />
 *
 * Por qué es seguro:
 *   - Sólo afecta displays >= 600dp. En teléfonos (< 600dp, el 100% real del parque
 *     en Cuba) el manifest cambia pero el comportamiento es idéntico.
 *   - No toca JS: es puramente declarativo en el manifest.
 *
 * Detalle de implementación:
 *   Es un <property> hijo de <application>, NO un <meta-data>. @expo/config-plugins
 *   (55.0.8) sólo exporta helpers para `meta-data` y `uses-library`, así que hay que
 *   empujar al array `application.property` a mano. Verificado que sobrevive el
 *   `sortAndroidManifest` del write: usa `[...new Set(order.concat(obj))]`, que
 *   preserva las keys que no conoce.
 *
 * ⚠️ ESTO ES DEUDA TÉCNICA CON FECHA DE VENCIMIENTO:
 *   Google deja de honrar esta property cuando la app targetee API 37. Antes de ese
 *   bump hay que hacer el trabajo real (layouts adaptativos, o aceptar landscape).
 *   No se puede extender el opt-out otra vez.
 *
 * Docs:
 *   https://developer.android.com/about/versions/16/behavior-changes-16#adaptive-layouts
 *
 * Aplica a cliente + driver (plugin duplicado — los config plugins de Expo son
 * per-app, no compartibles vía packages del monorepo).
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
