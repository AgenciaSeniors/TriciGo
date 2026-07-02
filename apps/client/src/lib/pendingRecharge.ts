// ============================================================
// Pending-recharge persistence (Track 2a — resume-poll recovery).
//
// If the user closes/backgrounds the app while a recharge is still
// "Verificando tu pago…" (common on slow Cuban links + the 3-D Secure
// SMS detour), the completing webhook is never reflected in-session. We
// persist the pending intentId here so the recharge screen can re-check
// it on focus / app-resume and surface the settled result.
//
// DUPLICATE across apps/client + apps/driver — keep byte-identical
// (enforced by scripts/check-netopia-checkout-sync.mjs). Per-app so the
// web build never pulls in AsyncStorage.
// ============================================================
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pendingRechargeIntent';
const MAX_AGE_MS = 60 * 60 * 1000; // 1h — after this an intent is expired anyway.

export async function savePendingRecharge(intentId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ intentId, at: Date.now() }));
  } catch {
    /* non-fatal: recovery is best-effort */
  }
}

/** Returns the pending intentId if one is stored and < 1h old, else null (and drops stale). */
export async function loadPendingRecharge(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { intentId?: string; at?: number };
    if (!parsed?.intentId || typeof parsed.at !== 'number' || Date.now() - parsed.at > MAX_AGE_MS) {
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    return parsed.intentId;
  } catch {
    return null;
  }
}

export async function clearPendingRecharge(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}
