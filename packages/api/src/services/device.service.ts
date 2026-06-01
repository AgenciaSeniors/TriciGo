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
   * List the current user's known devices, newest activity first. RLS
   * policy `ukd_select_own` scopes the result to the caller's own rows.
   */
  async listMyDevices(): Promise<KnownDevice[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('user_known_devices')
      .select(
        'id, device_id, platform, model, os_version, app_version, first_seen_at, last_seen_at',
      )
      .order('last_seen_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as KnownDevice[];
  },

  /**
   * Remove one of the current user's known devices by row id. RLS policy
   * `ukd_delete_own` ensures a user can only delete their own rows; the next
   * login from that device is treated as new again.
   */
  async revokeDevice(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('user_known_devices')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },
};
