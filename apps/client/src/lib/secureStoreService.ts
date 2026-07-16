/**
 * `keychainService` for the expo-secure-store entries read outside the
 * foreground — here, just the Supabase session.
 *
 * Duplicated per-app, like lib/device.ts. See the driver's copy for the full
 * rationale; short version: expo-secure-store applies `keychainAccessible` on
 * its SecItemAdd path only, and an existing key takes SecItemUpdate, which never
 * rewrites kSecAttrAccessible. keychainService is part of the entry's identity,
 * so writing under a new one is an Add and AFTER_FIRST_UNLOCK actually sticks.
 * The old entry is adopted on first read, never deleted first.
 *
 * lib/device.ts deliberately stays on the default service — it is only ever
 * called from foreground screens, so it never meets a locked keychain, and
 * moving it would churn the stable install id for no gain.
 *
 * This app has no background location task, so it is far less exposed than the
 * driver's, but a push notification still wakes it while locked.
 *
 * Not iOS-only: Android has no keychainAccessible, but it DOES honour
 * keychainService (it prefixes the stored key and names the keystore alias), so
 * renaming relocates Android entries too and they take the same adoption path.
 *
 * Changing this value orphans every stored entry — don't, unless you also add
 * the current value to the legacy chain.
 */
export const SECURE_STORE_SERVICE = 'tricigo-client-v2';
