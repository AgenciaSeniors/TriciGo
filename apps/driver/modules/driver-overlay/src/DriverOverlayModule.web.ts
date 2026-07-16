// Web: no-op. System overlays and background activity launch are
// Android-only concepts; the driver web surface never uses this module.
export const isDriverOverlayAvailable = false;

export default {
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
