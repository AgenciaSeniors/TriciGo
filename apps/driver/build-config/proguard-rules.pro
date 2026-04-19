# ============================================================
# TriciGo Driver — ProGuard / R8 rules
# ============================================================
# Every dependency that uses reflection, JNI, or serialization at
# runtime needs an explicit -keep so R8 doesn't strip it. Adding a
# new native lib or Stripe-style SDK? Add a rule here before shipping.
# ============================================================

# Preserve line numbers so Sentry stack traces are useful.
-keepattributes LineNumberTable,SourceFile
-renamesourcefileattribute SourceFile

# ── Hermes VM ──────────────────────────────────────────────────────
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# ── React Native new-architecture / Fabric / TurboModules ─────────
-keep class com.facebook.react.bridge.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
}

# ── Reanimated / Worklets ─────────────────────────────────────────
-keep class com.swmansion.reanimated.** { *; }
-keep class com.swmansion.worklets.** { *; }

# ── React Native Screens ───────────────────────────────────────────
-keep class com.swmansion.rnscreens.** { *; }

# ── React Native SVG ───────────────────────────────────────────────
-keep class com.horcrux.svg.** { *; }

# ── React Native Gesture Handler ───────────────────────────────────
-keep class com.swmansion.gesturehandler.** { *; }

# ── React Native community libs (AsyncStorage, NetInfo, WebView, …) ─
# Catch-all para cualquier lib bajo el namespace com.reactnativecommunity.
# Cubre @react-native-async-storage/async-storage, @react-native-community/netinfo,
# react-native-webview, y futuras libs que sigan esta convención.
-keep class com.reactnativecommunity.** { *; }
-keep interface com.reactnativecommunity.** { *; }
-dontwarn com.reactnativecommunity.**

# ── AsyncStorage (explícito, además del catch-all) ─────────────────
# Usado en boot: auth store, location buffer, voice guidance pref.
-keep class com.reactnativecommunity.asyncstorage.** { *; }
-keepclassmembers class com.reactnativecommunity.asyncstorage.** { *; }

# ── Safe Area Context (th3rdwave) ──────────────────────────────────
-keep class com.th3rdwave.safeareacontext.** { *; }
-dontwarn com.th3rdwave.safeareacontext.**

# ── DateTimePicker (reactcommunity) ────────────────────────────────
-keep class com.reactcommunity.rndatetimepicker.** { *; }
-dontwarn com.reactcommunity.**

# ── Vector Icons (oblador) ─────────────────────────────────────────
# Carga fuentes TTF por nombre en runtime; keepnames por seguridad.
-keep class com.oblador.vectoricons.** { *; }
-keepnames class com.oblador.** { *; }

# ── Assets referenciados por nombre (fonts, raw) ──────────────────
# shrinkResources puede eliminar TTFs si no detecta referencia estática.
# RN/Expo cargan fuentes por nombre string → R8 no las puede trazar.
-keep class **.R$* { *; }
-keepclassmembers class **.R$raw { *; }
-keepclassmembers class **.R$font { *; }
-keepclassmembers class **.R$drawable { *; }

# ── Expo modules core ──────────────────────────────────────────────
-keep class expo.modules.** { *; }
-keep class expo.** { *; }
-dontwarn expo.modules.**

# ── expo-av (sound effects) ────────────────────────────────────────
-keep class expo.modules.av.** { *; }

# ── Mapbox Maps SDK v10 ────────────────────────────────────────────
-keep class com.mapbox.** { *; }
-keep interface com.mapbox.** { *; }
-dontwarn com.mapbox.**

# rnmapbox/maps bridge
-keep class com.rnmapbox.rnmbx.** { *; }
-dontwarn com.rnmapbox.rnmbx.**

# ── Sentry (@sentry/react-native) ──────────────────────────────────
-keep class io.sentry.** { *; }
-keep class com.getsentry.** { *; }
-keep class io.sentry.android.** { *; }
-dontwarn io.sentry.**

# ── PostHog analytics ──────────────────────────────────────────────
-keep class com.posthog.** { *; }
-dontwarn com.posthog.**

# ── OkHttp / Okio (Supabase client transport) ─────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# ── Kotlin coroutines ──────────────────────────────────────────────
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembernames class kotlinx.** { volatile <fields>; }
-dontwarn kotlinx.coroutines.flow.**

# ── Firebase / Google Play Services (push + location) ─────────────
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**

# ── Parcelable / Serializable classes ──────────────────────────────
-keepclassmembers class * implements android.os.Parcelable {
  public static final android.os.Parcelable$Creator CREATOR;
}
-keepnames class * implements java.io.Serializable
-keepclassmembers class * implements java.io.Serializable {
  static final long serialVersionUID;
  private static final java.io.ObjectStreamField[] serialPersistentFields;
  !static !transient <fields>;
  private void writeObject(java.io.ObjectOutputStream);
  private void readObject(java.io.ObjectInputStream);
  java.lang.Object writeReplace();
  java.lang.Object readResolve();
}

# ── Enums & native methods ─────────────────────────────────────────
-keepclassmembers enum * {
  public static **[] values();
  public static ** valueOf(java.lang.String);
}
-keepclasseswithmembernames class * {
  native <methods>;
}

# ── App package (TriciGo Driver) ───────────────────────────────────
-keep class app.tricigo.driver.** { *; }
