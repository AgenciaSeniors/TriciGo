// ============================================================
// TriciGo — Auth Service
// Phone-based OTP authentication via Supabase Auth
// ============================================================

import type { User } from '@tricigo/types';
import { getSupabaseClient } from '../client';

declare const __DEV__: boolean | undefined;

export const authService = {
  /**
   * Send OTP to a phone number.
   */
  async sendOTP(phone: string) {
    const supabase = getSupabaseClient();
    // Dev bypass: skip Twilio SMS in development
    if ((typeof __DEV__ !== 'undefined' && __DEV__) || process.env.NODE_ENV === 'development') {
      console.log('[DEV] OTP bypass active — use code 000000');
      // Still call signInWithOtp to create/find the user, but don't fail if SMS fails
      try {
        await supabase.auth.signInWithOtp({ phone });
      } catch {
        console.log('[DEV] SMS send failed (expected without Twilio), continuing...');
      }
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({ phone });
    if (error) throw error;
  },

  /**
   * Verify the OTP code and establish a session.
   */
  async verifyOTP(phone: string, token: string) {
    const supabase = getSupabaseClient();
    // Dev bypass: accept "000000" and sign in with email/password
    if (((typeof __DEV__ !== 'undefined' && __DEV__) || process.env.NODE_ENV === 'development') && token === '000000') {
      const devEmail = `dev_${phone.replace(/\+/g, '')}@tricigo.test`;
      // Try signInWithPassword first (user may already have dev credentials)
      const { data: pwData, error: pwError } = await supabase.auth.signInWithPassword({
        email: devEmail,
        password: 'dev000000',
      });
      if (!pwError && pwData.session) return pwData;
      // If that fails, try the real OTP verification as fallback
      console.log('[DEV] Password login failed, trying real OTP...');
    }
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token,
      type: 'sms',
    });
    if (error) throw error;
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

    // Fetch the image as a blob
    const response = await fetch(fileUri);
    const blob = await response.blob();

    const filePath = `${userId}/avatar.jpg`;

    // Upload (upsert) to avatars bucket
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(filePath, blob, {
        contentType: 'image/jpeg',
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
   */
  async signOut() {
    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
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
