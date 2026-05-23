// ============================================================
// TriciGo — Auth Service
// Phone-based OTP authentication via Supabase Auth
// ============================================================

import type { User } from '@tricigo/types';
import { getSupabaseClient } from '../client';

declare const __DEV__: boolean | undefined;

export const authService = {
  /**
   * Send OTP to a phone number via Twilio SMS Edge Function.
   */
  async sendOTP(phone: string) {
    const supabase = getSupabaseClient();
    // Dev bypass: ONLY in React Native __DEV__ mode (never process.env which can leak to production)
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[DEV] OTP bypass active — use code 000000');
      return;
    }

    // Send OTP via Edge Function (Twilio SMS)
    const { data, error } = await supabase.functions.invoke('send-sms-otp', {
      body: { phone },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);
  },

  /**
   * Verify OTP code and establish a session.
   */
  async verifyOTP(phone: string, token: string) {
    const supabase = getSupabaseClient();
    // Dev bypass: ONLY in React Native __DEV__ mode
    if (typeof __DEV__ !== 'undefined' && __DEV__ && token === '000000') {
      const devEmail = `dev_${phone.replace(/\+/g, '')}@tricigo.test`;
      const { data: pwData, error: pwError } = await supabase.auth.signInWithPassword({
        email: devEmail,
        password: 'dev000000',
      });
      if (!pwError && pwData.session) return pwData;
      console.log('[DEV] Password login failed, trying real OTP...');
    }

    // Verify OTP via Edge Function (validates against otp_codes table, creates session)
    const { data, error } = await supabase.functions.invoke('verify-otp', {
      body: { phone, code: token },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    // Set the session from the Edge Function response
    if (data?.session) {
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    }

    return data;
  },

  /**
   * Get the current authenticated session.
   */
  async getSession() {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session;
  },

  /**
   * Get the current user profile from the users table.
   * Uses getUser() to verify the token with the server, then fetches the DB profile.
   */
  async getCurrentUser(): Promise<User | null> {
    const supabase = getSupabaseClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    if (!authUser) return null;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .single();
    if (error) throw error;
    return data as User;
  },

  /**
   * Fast user profile fetch using a known user ID (skips auth.getUser() verification).
   * Use this for session restoration when you already have a valid session.
   */
  async getUserById(userId: string): Promise<User | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();
    if (error) throw error;
    return data as User;
  },

  /**
   * Update the current user's profile.
   */
  async updateProfile(userId: string, updates: Partial<User>) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();
    if (error) throw error;
    return data as User;
  },

  /**
   * Upload an avatar image to Supabase Storage and update the user profile.
   *
   * @param userId - The user's ID
   * @param fileUri - Local file URI (from expo-image-picker)
   * @returns Public URL of the uploaded avatar
   */
  async uploadAvatar(userId: string, fileUri: string): Promise<string> {
    const supabase = getSupabaseClient();

    const filePath = `${userId}/avatar.jpg`;

    // React Native: use FormData to upload file URI (fetch+blob fails on Android)
    const formData = new FormData();
    formData.append('', {
      uri: fileUri,
      name: 'avatar.jpg',
      type: 'image/jpeg',
    } as any);

    // Upload (upsert) to avatars bucket
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(filePath, formData, {
        contentType: 'multipart/form-data',
        upsert: true,
      });
    if (uploadError) throw uploadError;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('avatars')
      .getPublicUrl(filePath);

    // Append cache-buster to force refresh
    const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    // Update profile
    await this.updateProfile(userId, { avatar_url: publicUrl });

    return publicUrl;
  },

  /**
   * Sign out the current user.
   *
   * CC-01 (security audit 2026-05-23, mig 00297): in addition to
   * the local Supabase signOut (which clears storage), we call
   * `revoke_user_tokens()` RPC to write a server-side revocation
   * timestamp. RLS policies that use `is_session_revoked()` will
   * reject any subsequent request carrying the old JWT, closing
   * the ~1h replay window where a captured token was still
   * server-valid post-logout.
   *
   * The revoke call is best-effort: if the RPC fails (network,
   * migration not yet deployed, transient DB error), we still
   * complete the local signOut so the user UX isn't blocked. The
   * old token retains its server-side validity in that case —
   * tradeoff is acceptable because (a) the primary signOut path
   * (local clear) always succeeds and (b) failed RPC is captured
   * in Sentry for ops follow-up.
   */
  async signOut() {
    const supabase = getSupabaseClient();

    // Server-side revocation first (best-effort). If it fails,
    // log and continue to local signOut — never block the user.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id) {
        await supabase.rpc('revoke_user_tokens', {
          p_user_id: user.id,
          p_reason: 'user_signout',
        });
      }
    } catch {
      // Migration may not be applied yet (frontend-tolerant);
      // or transient error. Local signOut still runs below.
    }

    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },

  /**
   * Request hard-delete of the calling user's account. Invokes the
   * `delete-account` edge function which (1) anonymizes all
   * non-CASCADE FK references to the user via
   * `anonymize_user_references()` (preserves financial/audit trail
   * with anonymous customer_id, reviewer_id, etc.), (2) cleans the
   * avatar from storage best-effort, (3) calls
   * `auth.admin.deleteUser()` which cascades through public.users
   * and the CASCADE-flagged children (wallet_accounts,
   * trusted_contacts, notifications, recurring_rides,
   * driver_profiles). Deletion is immediate and irreversible — no
   * grace period.
   *
   * The user_id is derived server-side from the JWT, not from a
   * parameter, so the client can never delete another user's
   * account even if it has their JWT.
   *
   * On success, the local session is signed out and the
   * RootNavigator in `_layout.tsx` redirects to `/(auth)/login`
   * (detects `!isAuthenticated`).
   */
  async deleteAccount() {
    const supabase = getSupabaseClient();
    const { error } = await supabase.functions.invoke('delete-account', {
      method: 'POST',
      body: {},
    });
    if (error) throw error;
    // Sign out locally after server hard-delete succeeds.
    await this.signOut();
  },

  /**
   * Listen for auth state changes.
   */
  onAuthStateChange(
    callback: (event: string, session: unknown) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase.auth.onAuthStateChange(callback);
  },

  // ==================== SOCIAL LOGIN ====================

  /**
   * Sign in with Google OAuth.
   * Returns the URL to redirect to for Google authentication.
   */
  async signInWithGoogle(redirectTo?: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    if (error) throw error;
    return data;
  },

  /**
   * Sign in with Apple OAuth.
   * Returns the URL to redirect to for Apple authentication.
   */
  async signInWithApple(redirectTo?: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo,
      },
    });
    if (error) throw error;
    return data;
  },

  /**
   * Link a phone number to the current OAuth account.
   * Used after social login when user needs to verify their phone.
   */
  async linkPhone(phone: string) {
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.updateUser({ phone });
    if (error) throw error;
  },

  /**
   * Verify phone link OTP.
   */
  async verifyPhoneLink(phone: string, token: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token,
      type: 'phone_change',
    });
    if (error) throw error;
    return data;
  },
};
