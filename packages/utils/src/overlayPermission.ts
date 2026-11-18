// ============================================================
// Driver app: when to ask for the permissions that let the app
// open itself when a ride offer arrives (Android).
//
// Step 1 is Android's "Display over other apps" (SYSTEM_ALERT_WINDOW).
// Step 2 only applies to Xiaomi, Redmi and POCO phones, which add their
// own "Display pop-up windows while running in the background"
// permission. It is off by default, canDrawOverlays() does not report
// it, and without it the system drops the launch silently.
//
// Each step has its own 3-day cooldown, so asking for step 1 never
// hides step 2. Spec:
// docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md
// ============================================================

/** How long an alert stays quiet after it was shown: 3 days. */
export const OVERLAY_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

const XIAOMI_FAMILY = /xiaomi|redmi|poco/i;

/** True for Xiaomi, Redmi and POCO phones, by manufacturer or brand. */
export function isXiaomiFamily(
  manufacturer: string | null | undefined,
  brand: string | null | undefined,
): boolean {
  return XIAOMI_FAMILY.test(manufacturer ?? '') || XIAOMI_FAMILY.test(brand ?? '');
}

/**
 * True when an alert last shown at `lastAt` may be shown again. Never
 * shown → due. A stored time in the future (the phone's clock was moved
 * back) → due, so a wrong clock cannot silence the alert for days.
 */
export function isPromptDue(
  lastAt: number | null,
  now: number,
  cooldownMs: number = OVERLAY_PROMPT_COOLDOWN_MS,
): boolean {
  if (lastAt === null) return true;
  const elapsed = now - lastAt;
  return elapsed < 0 || elapsed >= cooldownMs;
}

export interface OverlayStepInput {
  /** The DriverOverlay native module is in the binary (not an old APK + OTA JS). */
  moduleAvailable: boolean;
  /** canDrawOverlays() right now. */
  overlayGranted: boolean;
  xiaomiFamily: boolean;
  /** The driver confirmed the Xiaomi permission, or a launch was seen to succeed. */
  xiaomiOk: boolean;
  overlayPromptAt: number | null;
  xiaomiPromptAt: number | null;
  now: number;
}

export type OverlayStep = 'none' | 'overlay' | 'xiaomi';

/** Which alert, if any, to show now. */
export function nextOverlayStep(input: OverlayStepInput): OverlayStep {
  if (!input.moduleAvailable) return 'none';
  if (!input.overlayGranted) {
    return isPromptDue(input.overlayPromptAt, input.now) ? 'overlay' : 'none';
  }
  if (input.xiaomiFamily && !input.xiaomiOk && isPromptDue(input.xiaomiPromptAt, input.now)) {
    return 'xiaomi';
  }
  return 'none';
}
