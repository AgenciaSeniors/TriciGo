import { getSupabaseClient } from '../client';

export interface RegisterLoginDeviceInput {
  /** Stable per-install UUID (persisted in expo-secure-store on device). */
  device_id: string;
  platform?: string | null;
  model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
}

/** What a mobile app sends each time it is opened (report_app_open, migration 00622). */
export interface ReportAppOpenInput {
  app: 'client' | 'driver';
  /** The same per-install id the app sends at login. */
  device_id: string;
  app_version: string | null;
  platform: string | null;
}

/**
 * 'recorded' (a new install), 'updated', 'capped' (the account already has 20
 * installs of that app), 'invalid', or 'unavailable' while migration 00622 is
 * not applied.
 */
export type ReportAppOpenOutcome = 'recorded' | 'updated' | 'capped' | 'invalid' | 'unavailable';

/**
 * What happened when the driver app tried to come to the front for a ride offer:
 * it reached the front within 4 s, it did not (blocked, or the screen was off), or
 * it did not try because "Display over other apps" is not granted.
 */
export type DriverLaunchResult = 'foreground' | 'not_foreground' | 'no_permission';

/** What the driver app reports about its auto-open permissions (report_driver_overlay, migration 00689). */
export interface ReportDriverOverlayInput {
  /** The same per-install id the app sends at login. */
  device_id: string;
  manufacturer: string | null;
  brand: string | null;
  os_version: string | null;
  app_version: string | null;
  /** The DriverOverlay native module is in the binary. */
  module_available: boolean;
  /** "Display over other apps" is granted. */
  overlay_granted: boolean;
  /** Xiaomi-family phone: the driver confirmed the extra permission, or a launch reached the front. */
  xiaomi_ok: boolean;
  /** null for a plain status report. */
  launch_result: DriverLaunchResult | null;
}

/** As ReportAppOpenOutcome: 'unavailable' while migration 00689 is not applied. */
export type ReportDriverOverlayOutcome = 'recorded' | 'updated' | 'capped' | 'invalid' | 'unavailable';

/** A device row recorded in user_known_devices (returned by listMyDevices). */
export interface KnownDevice {
  id: string;
  device_id: string;
  platform: string | null;
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export const deviceService = {
  /**
   * Record this device against the logged-in user for new-device login
   * detection (register-login-device EF). The EF reads the user from the
   * session JWT that functions.invoke attaches, records the device, and
   * emails a "new device" alert only when the device is genuinely unseen
   * and the user already had a known device.
   *
   * Fire-and-forget from the UI — callers should .catch(() => {}) so a
   * device-check failure never blocks the login flow.
   */
  async registerLoginDevice(input: RegisterLoginDeviceInput): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.functions.invoke('register-login-device', {
      body: input,
    });
    if (error) throw error;
  },

  /**
   * Record that this app was opened, with its version (report_app_open,
   * migration 00622). Unlike registerLoginDevice it never emails and never
   * touches user_known_devices, so it is safe on every open: it only keeps
   * one row per account, app and install in app_opens, which is how we tell
   * which builds are still in use.
   *
   * Fire-and-forget from the apps. Resolves 'unavailable' while the
   * migration is not applied; throws any other error.
   */
  async reportAppOpen(input: ReportAppOpenInput): Promise<ReportAppOpenOutcome> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('report_app_open', {
      p_app: input.app,
      p_device_id: input.device_id,
      p_app_version: input.app_version ?? null,
      p_platform: input.platform ?? null,
    });
    if (error) {
      if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
        return 'unavailable';
      }
      throw error;
    }
    return data as ReportAppOpenOutcome;
  },

  /**
   * Record the driver app's auto-open status on this install, and the result of
   * a launch attempt when there is one (report_driver_overlay, migration 00689).
   * Tells the server which drivers the app can open by itself on an offer.
   *
   * Fire-and-forget from the driver app. Resolves 'unavailable' while the
   * migration is not applied; throws any other error.
   */
  async reportDriverOverlay(input: ReportDriverOverlayInput): Promise<ReportDriverOverlayOutcome> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('report_driver_overlay', {
      p_device_id: input.device_id,
      p_manufacturer: input.manufacturer,
      p_brand: input.brand,
      p_os_version: input.os_version,
      p_app_version: input.app_version,
      p_module_available: input.module_available,
      p_overlay_granted: input.overlay_granted,
      p_xiaomi_ok: input.xiaomi_ok,
      p_launch_result: input.launch_result,
    });
    if (error) {
      if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
        return 'unavailable';
      }
      throw error;
    }
    return data as ReportDriverOverlayOutcome;
  },

  /**
   * List the current user's known devices, newest activity first.
   *
   * The query is scoped EXPLICITLY to the authenticated user's id. We must NOT
   * rely on RLS alone here: the `ukd_admin_all` policy (FOR ALL USING
   * is_admin()) is permissive, so for an admin/super_admin caller RLS widens to
   * `user_id = auth.uid() OR is_admin()` and an unscoped SELECT would return
   * EVERY user's devices on this personal "Tus dispositivos" screen. The
   * explicit `.eq('user_id', …)` keeps the screen to the caller's own devices
   * regardless of their role; RLS still backstops it on the server.
   */
  async listMyDevices(): Promise<KnownDevice[]> {
    const supabase = getSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data, error } = await supabase
      .from('user_known_devices')
      .select(
        'id, device_id, platform, model, os_version, app_version, first_seen_at, last_seen_at',
      )
      .eq('user_id', user.id)
      .order('last_seen_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as KnownDevice[];
  },

  /**
   * Remove one of the current user's known devices by row id. Scoped to the
   * caller's own `user_id` as well as the row id — like listMyDevices, this
   * must not rely on RLS alone, since `ukd_admin_all` would otherwise let an
   * admin delete another user's device row by id. The next login from that
   * device is treated as new again.
   */
  async revokeDevice(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');
    const { error } = await supabase
      .from('user_known_devices')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) throw error;
  },
};
