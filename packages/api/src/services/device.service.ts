import { getSupabaseClient } from '../client';

export interface RegisterLoginDeviceInput {
  /** Stable per-install UUID (persisted in expo-secure-store on device). */
  device_id: string;
  platform?: string | null;
  model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
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
};
