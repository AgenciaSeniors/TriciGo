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
    const isDev = (typeof __DEV__ !== 'undefined' && __DEV__) || process.env.NODE_ENV === 'development';

    // Dev bypass: skip WhatsApp in development
    if (isDev) {
      console.log('[DEV] OTP bypass active — use code 000000');
      return;
    }

    // Send OTP via WhatsApp Edge Function
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

    const response = await fetch(`${supabaseUrl}/functions/v1/send-whatsapp-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ phone }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error((errorData as { error?: string }).error ?? 'Failed to send OTP');
    }
  },

  /**
   * Verify the OTP code and establish a session via WhatsApp OTP.
   */
  async verifyOTP(phone: string, token: string) {
    const supabase = getSupabaseClient();
    const isDev = (typeof __DEV__ !== 'undefined' && __DEV__) || process.env.NODE_ENV === 'development';

    // Dev bypass: accept "000000" and sign in with email/password
    if (isDev && token === '000000') {
      const devEmail = `dev_${phone.replace(/\+/g, '')}@tricigo.test`;
      const { data: pwData, error: pwError } = await supabase.auth.signInWithPassword({
        email: devEmail,
        password: 'dev000000',
      });
      if (!pwError && pwData.session) return pwData;
      console.log('[DEV] Password login failed, trying WhatsApp OTP...');
    }

    // Verify OTP via Edge Function
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

    const response = await fetch(`${supabaseUrl}/functions/v1/verify-whatsapp-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ phone, code: token }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error((errorData as { error?: string }).error ?? 'Invalid code');
    }

    const { session } = await response.json() as { session: { access_token: string; refresh_token: string } };

    if (session?.access_token && session?.refresh_token) {
      // Set the session in the Supabase client
      const { error: sessionError } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
      if (sessionError) throw sessionError;
    }

    const { data: currentSession } = await supabase.auth.getSession();
    return { session: currentSession.session, user: currentSession.session?.user ?? null };
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
