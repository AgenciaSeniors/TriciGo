// ============================================================
// TriciGo — Auth Service
// Email-based OTP authentication + Social Login via Supabase Auth
// ============================================================

import type { User } from '@tricigo/types';
import { getSupabaseClient } from '../client';

declare const __DEV__: boolean | undefined;

export const authService = {
  /**
   * Send OTP to an email address via the send-email-otp Edge Function.
   */
  async sendOTP(email: string) {
    const supabase = getSupabaseClient();
    // Dev bypass: ONLY in React Native __DEV__ mode (never process.env which can leak to production)
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[DEV] OTP bypass active — use code 000000');
      return;
    }

    // Send OTP via Edge Function (Resend email)
    const { data, error } = await supabase.functions.invoke('send-email-otp', {
      body: { email },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);
  },

  /**
   * Verify OTP code and establish a session.
   */
  async verifyOTP(email: string, token: string) {
    const supabase = getSupabaseClient();
    // Dev bypass: ONLY in React Native __DEV__ mode
    if (typeof __DEV__ !== 'undefined' && __DEV__ && token === '000000') {
      const devEmail = `dev_${email.replace(/[@.]/g, '_')}@tricigo.test`;
      const { data: pwData, error: pwError } = await supabase.auth.signInWithPassword({
        email: devEmail,
        password: 'dev000000',
      });
      if (!pwError && pwData.session) return pwData;
      console.log('[DEV] Password login failed, trying real OTP...');
    }

    // Verify OTP via Edge Function (validates against otp_codes table, creates session)
    const { data, error } = await supabase.functions.invoke('verify-whatsapp-otp', {
      body: { email, code: token },
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
   * Get the current auth user metadata (for pre-filling profile from OAuth).
   */
  async getAuthUserMetadata(): Promise<Record<string, unknown> | null> {
    const supabase = getSupabaseClient();
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    return authUser?.user_metadata ?? null;
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
};
