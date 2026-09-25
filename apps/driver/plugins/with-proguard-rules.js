/**
 * Expo config plugin — inyectar `build-config/proguard-rules.pro` en el
 * proyecto Android generado por prebuild.
 *
 * IDÉNTICO a apps/client/plugins/with-proguard-rules.js — duplicado porque
 * los config plugins de Expo son per-app (cada app.json registra su propia
 * carpeta plugins/), no compartibles vía packages del monorepo. Mantenimiento:
 * al actualizar uno, sincronizar el otro.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * Las reglas de keep viven desde hace más de un año en
 * `apps/<app>/build-config/proguard-rules.pro` (~140 líneas, con comentarios
 * que explican POR QUÉ cada lib necesita su regla). Pero hasta ahora SOLO las
 * leía el workflow `android-apk.yml`, que las copia a mano después de
 * prebuild. El build de producción de EAS —el AAB que va a Play— nunca las
 * aplicaba, porque nunca activó R8: el archivo estaba escrito, mantenido y
 * muerto para el artefacto que importa.
 *
 * ── Por qué NO `expo-build-properties.extraProguardRules` ────────────────
 * Esa opción existe y hace exactamente esta inyección, pero recibe un STRING
 * dentro de app.json. Meter 140 líneas de reglas como string JSON significa
 * tener el mismo conjunto de reglas en dos lugares — y dos copias a mano del
 * mismo dato siempre divergen. El `.pro` sigue siendo la única fuente; este
 * plugin lo lee.
 *
 * ── Interacción con expo-build-properties ────────────────────────────────
 * Ese plugin registra un `withAndroidPurgeProguardRulesOnce` que borra
 * contenido, pero SOLO el suyo: `purgeContents` filtra por el tag
 * `expo-build-properties`. Lo que escribimos acá lleva otro centinela y no lo
 * toca. Igual este plugin se registra DESPUÉS en el array de app.json, así
 * que su mod corre después del purge.
 *
 * ── Fallar ruidosamente es lo correcto ───────────────────────────────────
 * Si el `.pro` no está, esto LANZA y el prebuild se cae. Es deliberado: con
 * R8 activo y sin reglas, R8 elimina clases que Mapbox/Sentry/Expo resuelven
 * por reflexión y la app compila perfecto para crashear en el teléfono del
 * usuario. Un build roto es infinitamente mejor que un APK roto.
 */

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SENTINEL = '# >>> TriciGo build-config/proguard-rules.pro (with-proguard-rules) >>>';

/**
 * Fusiona las reglas de TriciGo con el `proguard-rules.pro` que genera
 * prebuild. Pura y exportada para poder testearla sin un proyecto Android.
 *
 * Idempotente por centinela: un segundo prebuild sobre el mismo árbol no
 * duplica las reglas.
 */
function mergeProguardRules(generated, tricigoRules) {
  if (generated.includes(SENTINEL)) return generated;
  const head = generated.replace(/\s+$/, '');
  const body = tricigoRules.replace(/\s+$/, '');
  return `${head}\n\n${SENTINEL}\n${body}\n`;
}

module.exports = function withProguardRules(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'build-config', 'proguard-rules.pro');
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');

      // Sin try/catch a propósito — ver "Fallar ruidosamente" arriba.
      const rules = fs.readFileSync(src, 'utf8');
      const generated = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      const merged = mergeProguardRules(generated, rules);
      if (merged !== generated) fs.writeFileSync(dest, merged, 'utf8');
      return cfg;
    },
  ]);
};

module.exports.mergeProguardRules = mergeProguardRules;
module.exports.SENTINEL = SENTINEL;
