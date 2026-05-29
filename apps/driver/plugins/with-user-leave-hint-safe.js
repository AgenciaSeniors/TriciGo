/**
 * Expo config plugin — null-safe wrapper around onUserLeaveHint() in
 * MainActivity to prevent FATAL NullPointerException in
 * ReactActivityDelegate.onUserLeaveHint (RN 0.83.x).
 *
 * IDENTICAL to apps/client/plugins/with-user-leave-hint-safe.js — duplicated
 * because Expo config plugins are per-app (each app.json registers its own
 * plugins folder). Source of truth is documented in apps/client/plugins.
 *
 * Driver bug not yet reproduced in QA but applies same race condition:
 * cold-start + background → NPE in ReactActivityDelegate. Driver is more
 * vulnerable than cliente in scenarios like background location task (FD1)
 * resuming the activity while user is in another app. Preemptive fix.
 *
 * Maintenance: when updating one, keep the other in sync.
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
  if (contents.includes(SENTINEL)) {
    return contents;
  }

  // Insert right after the class opening brace so the override always lands
  // INSIDE the class body. The previous anchor (after getMainComponentName)
  // broke on Expo SDK 55: its expression-body methods have no braces, so
  // `getMainComponentName()[^}]*}` ran past the class's own closing brace and
  // injected the override OUTSIDE the class. (Keep in sync with apps/client.)
  const classOpen = /(class\s+\w+\s*:\s*ReactActivity\s*\([^)]*\)\s*\{)/;
  if (classOpen.test(contents)) {
    return contents.replace(classOpen, (m) => `${m}\n${KOTLIN_OVERRIDE}`);
  }

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

module.exports = function withUserLeaveHintSafe(config) {
  return withMainActivity(config, (config) => {
    if (config.modResults.language !== 'kt') {
      throw new Error(
        `[with-user-leave-hint-safe] expected Kotlin MainActivity, got ${config.modResults.language}`,
      );
    }
    config.modResults.contents = injectOverride(config.modResults.contents);
    return config;
  });
};
