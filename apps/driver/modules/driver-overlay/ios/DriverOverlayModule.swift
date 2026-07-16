import ExpoModulesCore

/**
 * driver-overlay (iOS) — no-op stubs. iOS has no system-wide overlay windows
 * and no background activity launch; the Android module is the real
 * implementation. canDrawOverlays() returns false so all JS wiring
 * short-circuits to the push-notification path.
 */
public class DriverOverlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DriverOverlay")

    Function("canDrawOverlays") { () -> Bool in
      return false
    }

    Function("openOverlaySettings") {}

    Function("bringAppToForeground") {}

    Function("showBubble") { () -> Bool in
      return false
    }

    Function("hideBubble") {}
  }
}
