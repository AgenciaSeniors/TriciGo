package expo.modules.driveroverlay

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * driver-overlay (Android) — everything built on the user-granted
 * SYSTEM_ALERT_WINDOW ("Display over other apps") permission:
 *
 *  - bringAppToForeground(): relaunch MainActivity from the background when a
 *    ride offer arrives over Realtime (the expo-location foreground service
 *    keeps the JS runtime alive while the driver is online). Holding SAW is a
 *    documented exemption from Android 10+ background-activity-launch
 *    restrictions — without the grant the startActivity is silently ignored
 *    by the system and the push-notification path remains the UX.
 *  - showBubble()/hideBubble(): a draggable chat-head (BubbleService +
 *    WindowManager) shown while the app is backgrounded so the driver can
 *    jump back with one tap.
 *
 * All functions are Android-only; iOS/web ship no-op stubs.
 */
class DriverOverlayModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context lost" }

  override fun definition() = ModuleDefinition {
    Name("DriverOverlay")

    Function("canDrawOverlays") {
      Settings.canDrawOverlays(context)
    }

    Function("openOverlaySettings") {
      try {
        val intent = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      } catch (e: Exception) {
        // Some OEM ROMs don't resolve the per-app screen; fall back to the list.
        try {
          context.startActivity(
            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
          )
        } catch (e2: Exception) {
          Log.w(TAG, "openOverlaySettings failed", e2)
        }
      }
    }

    Function("bringAppToForeground") {
      launchMainActivity(context)
    }

    Function("showBubble") {
      if (!Settings.canDrawOverlays(context)) return@Function false
      try {
        // Only called while the driver is online, so the expo-location FGS
        // keeps procstate at foreground-service level → startService is legal.
        // The try/catch guards the offline+backgrounded misuse case
        // (IllegalStateException on API 26+).
        context.startService(Intent(context, BubbleService::class.java))
        true
      } catch (e: Exception) {
        Log.w(TAG, "showBubble failed", e)
        false
      }
    }

    Function("hideBubble") {
      try {
        context.stopService(Intent(context, BubbleService::class.java))
      } catch (_: Exception) {}
    }

    OnDestroy {
      // JS reload / process teardown: never leak the overlay window.
      appContext.reactContext?.let {
        try {
          it.stopService(Intent(it, BubbleService::class.java))
        } catch (_: Exception) {}
      }
    }
  }

  companion object {
    internal const val TAG = "DriverOverlay"

    fun launchMainActivity(context: Context) {
      // NEW_TASK is mandatory when starting from a non-Activity context
      // (Service / module); SINGLE_TOP avoids stacking duplicate MainActivities
      // when offers arrive back-to-back.
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?.apply {
          addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
              Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED or
              Intent.FLAG_ACTIVITY_SINGLE_TOP,
          )
        } ?: return
      try {
        context.startActivity(intent)
      } catch (e: Exception) {
        Log.w(TAG, "bringAppToForeground failed", e)
      }
    }
  }
}
