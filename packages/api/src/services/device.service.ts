import { getSupabaseClient } from '../client';

export interface RegisterLoginDeviceInput {
  /** Stable per-install UUID (persisted in expo-secure-store on device). */
  device_id: string;
  platform?: string | null;
  model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
}

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
