/**
 * `keychainService` for the expo-secure-store entries this app reads outside the
 * foreground: the Supabase session and the background-task ctx.
 *
 * It is not cosmetic. expo-secure-store applies `keychainAccessible` on its
 * SecItemAdd path only: when the key already exists, SecItemAdd returns
 * errSecDuplicateItem and the module falls back to SecItemUpdate, whose update
 * dictionary carries kSecValueData alone and never rewrites kSecAttrAccessible
 * (SecureStoreModule.swift:127-144). An entry written before we started asking
 * for AFTER_FIRST_UNLOCK would therefore stay unreadable-while-locked forever,
 * however often it is rewritten — and iOS wakes this app in the background, with
 * the phone locked in the driver's pocket, on every location batch.
 *
 * keychainService is part of the entry's identity, so writing under a new one is
 * an Add rather than an Update and the accessibility sticks. Entries under the
 * old service are adopted on first read (the `legacy` option of
 * createStorageAdapter) instead of being deleted and rewritten: nothing may
 * delete an entry before its replacement is stored. An earlier draft did exactly
 * that and reproduced the bug it was fixing — a location batch landing in the
 * gap read the ctx as absent and stopped the task.
 *
 * Not iOS-only: Android has no keychainAccessible, but it DOES honour
 * keychainService (createKeychainAwareKey prefixes the stored key, and it names
 * the keystore alias), so renaming relocates Android entries too and they take
 * the same adoption path. Worth exercising an upgrade-over-old-build on Android.
 *
 * lib/device.ts deliberately stays on the default service — it is only ever
 * called from foreground screens (verify-otp, profile/devices), so it never
 * meets a locked keychain, and moving it would churn the stable install id for
 * no gain.
 *
 * Plain string, no native import, so the web bundle can reference it freely.
 *
 * Changing this value orphans every stored entry — don't, unless you also add
 * the current value to the legacy chain.
 */
export const SECURE_STORE_SERVICE = 'tricigo-driver-v2';
