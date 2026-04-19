// ============================================================
// TriciGo Client — React Native CLI autolinking overrides
// ============================================================
// Controls which native modules get autolinked per platform.
// Packages listed with `platforms: { android: null }` are skipped
// on Android during `expo prebuild` / gradle autolinking, so their
// native Kotlin/Java code is NOT compiled into the APK.
// ============================================================

module.exports = {
  dependencies: {
    // @stripe/stripe-react-native v0.49.0 has a Kotlin compile bug
    // (ReadableMap? vs ReadableMap nullability mismatch) that breaks
    // compileReleaseKotlin. We don't need Stripe native on Android
    // for the Cuba rollout — US sanctions block Stripe inside Cuba
    // anyway, so the app falls back to opening the web wallet for
    // recharges. stripe-bootstrap.tsx already handles the missing
    // native module with a try/catch.
    '@stripe/stripe-react-native': {
      platforms: {
        android: null,
      },
    },
  },
};
