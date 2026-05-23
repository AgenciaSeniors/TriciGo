// ============================================================
// TriciGo Client — React Native CLI autolinking overrides
// ============================================================
// Controls which native modules get autolinked per platform.
// Currently empty — Stripe React Native SDK was removed in
// PR (D3 / Store Readiness) because:
//   - US sanctions block Stripe inside Cuba (target market).
//   - All recharges use NETOPIA via WebBrowser-hosted page,
//     not native StoreKit / Payment Sheet.
//   - The SDK never had a caller in client code (stripe-bootstrap
//     was removed in a prior refactor).
//
// Keep this file as a placeholder so future native dependency
// overrides have a clear home.
// ============================================================

module.exports = {
  dependencies: {},
};
