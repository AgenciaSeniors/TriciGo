package expo.modules.driveroverlay

import android.app.Service
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import kotlin.math.abs

/**
 * Floating chat-head shown while the driver app is backgrounded (and the
 * driver is online). Tap → relaunch MainActivity. Draggable.
 *
 * Deliberately a plain started Service, NOT a foreground service: it only
 * runs while the expo-location location FGS is already keeping the process
 * alive (driver online), and a second FGS would need its own
 * foregroundServiceType justification in Play review for nothing.
 */
class BubbleService : Service() {
  private var windowManager: WindowManager? = null
  private var bubbleView: View? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (bubbleView == null) addBubble() // idempotent: repeated showBubble() no-ops
    // If the system kills us, stay dead — the JS AppState hook re-shows the
    // bubble on the next background transition; a sticky restart would draw a
    // zombie bubble with no owner.
    return START_NOT_STICKY
  }

  private fun addBubble() {
    if (!Settings.canDrawOverlays(this)) {
      stopSelf()
      return
    }
    val wm = getSystemService(WINDOW_SERVICE) as WindowManager
    windowManager = wm

    val size = (BUBBLE_SIZE_DP * resources.displayMetrics.density).toInt()
    val view = ImageView(this).apply {
      // App icon as the bubble face — resolved from the app's own resources,
      // no drawable assets needed inside the module.
      val iconId = resources.getIdentifier("ic_launcher_round", "mipmap", packageName)
        .takeIf { it != 0 }
        ?: resources.getIdentifier("ic_launcher", "mipmap", packageName)
      if (iconId != 0) setImageResource(iconId)
      contentDescription = "TriciGo"
      elevation = 8f
    }

    @Suppress("DEPRECATION")
    val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      // minSdk 24 → API 24/25 still need the legacy type.
      WindowManager.LayoutParams.TYPE_PHONE
    }

    val params = WindowManager.LayoutParams(
      size,
      size,
      overlayType,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = resources.displayMetrics.widthPixels - size - (24 * resources.displayMetrics.density).toInt()
      y = resources.displayMetrics.heightPixels / 3
    }

    // Drag vs tap discrimination via touch slop.
    view.setOnTouchListener(object : View.OnTouchListener {
      private var startX = 0
      private var startY = 0
      private var touchX = 0f
      private var touchY = 0f
      private var moved = false

      override fun onTouch(v: View, e: MotionEvent): Boolean = when (e.action) {
        MotionEvent.ACTION_DOWN -> {
          startX = params.x
          startY = params.y
          touchX = e.rawX
          touchY = e.rawY
          moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - touchX
          val dy = e.rawY - touchY
          if (abs(dx) > TOUCH_SLOP_PX || abs(dy) > TOUCH_SLOP_PX) moved = true
          params.x = startX + dx.toInt()
          params.y = startY + dy.toInt()
          try {
            wm.updateViewLayout(v, params)
          } catch (_: Exception) {}
          true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) {
            DriverOverlayModule.launchMainActivity(this@BubbleService)
            // The JS AppState hook hides the bubble on 'active'; stopSelf()
            // here as belt-and-suspenders so it never overlaps our own UI.
            stopSelf()
          }
          true
        }
        else -> false
      }
    })

    try {
      wm.addView(view, params)
      bubbleView = view
    } catch (e: Exception) {
      // BadTokenException if the permission was revoked between the JS check
      // and here — degrade silently, the push notification path still works.
      Log.w(DriverOverlayModule.TAG, "addView failed", e)
      stopSelf()
    }
  }

  override fun onDestroy() {
    bubbleView?.let { v ->
      try {
        windowManager?.removeView(v)
      } catch (_: Exception) {}
    }
    bubbleView = null
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // User swiped the app away from recents → the bubble goes too.
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private companion object {
    const val BUBBLE_SIZE_DP = 56
    const val TOUCH_SLOP_PX = 10
  }
}
