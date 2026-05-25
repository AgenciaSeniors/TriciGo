/**
 * Expo config plugin — null-safe wrapper around onUserLeaveHint() in
 * MainActivity to prevent FATAL NullPointerException in
 * ReactActivityDelegate.onUserLeaveHint (RN 0.83.x).
 *
 * Bug reproducido 2026-05-25 en `app.tricigo.client` (PIDs 25688 + 26797).
 * Stack trace canónico:
 *
 *   FATAL EXCEPTION: main
 *   Process: app.tricigo.client
 *   java.lang.NullPointerException
 *     at java.util.Objects.requireNonNull(Objects.java:235)
 *     at com.facebook.react.ReactActivityDelegate.onUserLeaveHint(
 *         ReactActivityDelegate.java:192)
 *     at com.facebook.react.ReactActivity.onUserLeaveHint(
 *         ReactActivity.java:139)
 *     at android.app.Activity.performUserLeaving(Activity.java:9543)
 *     ...
 *
 * Causa raíz:
 *   - Android dispara `onUserLeaveHint()` cuando el usuario sale de la
 *     activity (home button, fast app switch, universal link redirect).
 *   - El ReactActivityDelegate de RN 0.83.x hace
 *     `Objects.requireNonNull(mDelegate)` antes de delegar el evento.
 *   - `mDelegate` se inicializa en `onCreate()`. Si Android llama
 *     `onUserLeaveHint()` ANTES de que `onCreate()` complete (race
 *     condition durante cold-start interrumpido, típico con deep links
 *     post-pago NETOPIA u otro flujo que pausa la app < 200 ms post-launch),
 *     el requireNonNull tira NPE → app crash.
 *
 * Fix:
 *   Override `onUserLeaveHint()` en MainActivity con try/catch alrededor
 *   del `super.onUserLeaveHint()`. Es seguro ignorar el NPE en este
 *   contexto porque:
 *     1. La activity está siendo backgrounded — JS bridge no tiene
 *        trabajo de UI pendiente que pueda quedar incompleto.
 *     2. El estado de la app se preserva (Android Activity lifecycle
 *        sigue normal, solo el callback dispatch al JS se omite).
 *     3. La próxima vez que la activity vuelva a foreground,
 *        `onResume()` reinicializa el delegate correctamente.
 *
 * Bug equivalente en upstream React Native:
 *   https://github.com/facebook/react-native/blob/v0.83.4/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactActivityDelegate.java#L192
 *
 * Fix aplica a cliente + driver (driver tiene el bug latente pero aún
 * no fue reproducido en QA porque el driver no usa universal links de
 * pago como el cliente).
 */

const { withMainActivity } = require('@expo/config-plugins');

const SENTINEL = 'TriciGo:user-leave-hint-safe';

const KOTLIN_OVERRIDE = `
  /**
   * RN 0.83.x bug fix (${SENTINEL}): ReactActivityDelegate.onUserLeaveHint
   * throws NPE when called before delegate.onCreate completes. Wrap super
   * call in try/catch. Safe to ignore — the activity is being backgrounded
   * anyway; JS bridge has no UI work pending that would be lost.
   */
  override fun onUserLeaveHint() {
    try {
      super.onUserLeaveHint()
    } catch (e: NullPointerException) {
      android.util.Log.w("TriciGo", "onUserLeaveHint NPE swallowed (RN 0.83.x delegate race)", e)
    }
  }
`;

function injectOverride(contents) {
  // Idempotency — don't double-inject if plugin runs twice during prebuild
  if (contents.includes(SENTINEL)) {
    return contents;
  }

  // Strategy: insert AFTER the `getMainComponentName()` function which
  // is always present in Expo-generated MainActivity.kt files. This
  // anchor is stable across SDK 50 → 55 (verified manually).
  const anchorRegex = /override fun getMainComponentName\(\)[^}]*\}/;

  if (!anchorRegex.test(contents)) {
    // Fallback: insert before the final closing brace of the class.
    // This is robust to Expo template changes that rename or remove
    // getMainComponentName.
    const lastBraceIdx = contents.lastIndexOf('}');
    if (lastBraceIdx === -1) {
      throw new Error(
        '[with-user-leave-hint-safe] MainActivity.kt has no closing brace — file may be corrupt',
      );
    }
    return (
      contents.slice(0, lastBraceIdx) +
      KOTLIN_OVERRIDE +
      '\n' +
      contents.slice(lastBraceIdx)
    );
  }

  return contents.replace(anchorRegex, (match) => match + KOTLIN_OVERRIDE);
}

module.exports = function withUserLeaveHintSafe(config) {
  return withMainActivity(config, (config) => {
    if (config.modResults.language !== 'kt') {
      // Expo SDK 50+ uses Kotlin by default. Java was deprecated SDK 49.
      // If we ever support Java MainActivity, add a separate branch here.
      throw new Error(
        `[with-user-leave-hint-safe] expected Kotlin MainActivity, got ${config.modResults.language}`,
      );
    }
    config.modResults.contents = injectOverride(config.modResults.contents);
    return config;
  });
};
