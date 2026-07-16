import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class DriverOverlayModule extends NativeModule<{}> {
  /**
   * True when the user granted "Display over other apps"
   * (SYSTEM_ALERT_WINDOW). Android-only; always false on iOS/web.
   * Cheap synchronous system check — safe to call on every AppState event,
   * which also handles mid-session revocation for free.
   */
  canDrawOverlays(): boolean;

  /** Open the system "Display over other apps" settings screen for this app. */
  openOverlaySettings(): void;

  /**
   * Relaunch MainActivity from the background (ride offer arrived while the
   * driver is in another app). Requires the SYSTEM_ALERT_WINDOW grant —
   * without it Android silently drops the background activity start.
   */
  bringAppToForeground(): void;

  /**
   * Show the draggable floating bubble over other apps. Returns false when
   * the permission is missing or the service could not start.
   */
  showBubble(): boolean;

  /** Remove the floating bubble. */
  hideBubble(): void;
}

// requireOptionalNativeModule returns null (instead of THROWING) when the
// native module isn't in the binary — e.g. a store build made before this
// local module existed, or a JS↔native/OTA mismatch (runtimeVersion
// 'appVersion' ships newer JS to older binaries). Same lesson as
// webview-proxy (client build-16 rejection): a throw at import would crash
// every route that imports this file. The fallback makes the whole feature a
// no-op: canDrawOverlays() → false short-circuits all call sites back to the
// push-notification behavior.
const nativeDriverOverlay = requireOptionalNativeModule<DriverOverlayModule>('DriverOverlay');

const fallbackDriverOverlay = {
  canDrawOverlays(): boolean {
    return false;
  },
  openOverlaySettings(): void {},
  bringAppToForeground(): void {},
  showBubble(): boolean {
    return false;
  },
  hideBubble(): void {},
};

export default nativeDriverOverlay ?? fallbackDriverOverlay;
