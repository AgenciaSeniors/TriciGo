// ============================================================
// TriciGo — Auth Service
// Phone-based OTP authentication via Supabase Auth
// ============================================================

import type { User } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { uploadFileFromUri } from './_storage-upload';

/**
 * Thrown when an OTP endpoint returns HTTP 429 (rate limited). Carries the
 * server-provided cooldown so the UI can keep the resend button disabled for
 * the right amount of time and tell the user how long to wait.
 */
export interface RateLimitError extends Error {
  code: 'rate_limited';
  /** Seconds the caller should wait before retrying. */
  retryAfterSec: number;
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return (
    err instanceof Error &&
    (err as RateLimitError).code === 'rate_limited' &&
    typeof (err as RateLimitError).retryAfterSec === 'number'
  );
}

/**
 * Inspect a supabase-js Functions error and, if it represents a 429, return a
 * typed RateLimitError. Returns null for any other error so callers can fall
 * back to generic handling.
 *
 * supabase-js puts the raw Response on `error.context` for HTTP errors. We read
 * the cooldown from the `Retry-After` header (works on native — no CORS), with a
 * fallback to the `retryAfterSec` field the edge function duplicates into the
 * JSON body (needed on web, where header access depends on CORS exposure).
 */
async function asRateLimitError(error: unknown): Promise<RateLimitError | null> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (!ctx || ctx.status !== 429) return null;

  let retryAfterSec = Number(ctx.headers?.get?.('Retry-After')) || 0;
  if (!retryAfterSec) {
    try {
      const body = await ctx.clone().json();
      if (typeof body?.retryAfterSec === 'number') retryAfterSec = body.retryAfterSec;
    } catch {
      /* body unreadable/consumed — fall through to default */
    }
  }

  const e = new Error('rate_limited') as RateLimitError;
  e.code = 'rate_limited';
  // Default to the per-phone window (5 min) when the server didn't tell us.
  e.retryAfterSec = retryAfterSec > 0 ? retryAfterSec : 300;
  return e;
}

export const authService = {
  /**
   * Send OTP to a phone number via Twilio SMS Edge Function.
   */
  async sendOTP(phone: string) {
    const supabase = getSupabaseClient();
    // No __DEV__ bypass here — see verifyOTP for why the old one was removed.
    // Demo/review logins are handled SERVER-side by send-sms-otp (resolveDemoOtp,
    // gated on DEMO_PHONE + DEMO_OTP_CODE): it seeds a fixed code without sending
    // an SMS. That is the path production already uses, so dev builds now behave
    // identically instead of diverging.

    // Send OTP via Edge Function (Twilio SMS)
    const { data, error } = await supabase.functions.invoke('send-sms-otp', {
      body: { phone },
    });

    if (error) {
      // Surface rate-limit (429) as a typed error so the UI can show a clear
      // "too many requests, wait N" message instead of a generic failure.
      const rl = await asRateLimitError(error);
      if (rl) throw rl;
      throw error;
    }
    if (data?.error) throw new Error(data.error);
  },

  /**
   * Verify OTP code and establish a session.
   */
  async verifyOTP(phone: string, token: string) {
    const supabase = getSupabaseClient();
    // No __DEV__ bypass here (removed 2026-07-31 — dead since it was written in
    // c76d1853, 2026-03-20). It signed in as dev_<phone>@tricigo.test with a fixed
    // password, but NOTHING in this repo has ever created those users — 0 exist in
    // prod and no seed/script/migration makes them — so it always fell through.
    // Meanwhile sendOTP's twin bypass had already returned early without seeding a
    // code, so the fallback had nothing to validate: the two halves cancelled out
    // and a dev build could not log in AT ALL. It stayed invisible for months only
    // because dev clients persist their session and rarely reach the login screen.
    // Mirrors verifyPhoneLink below, which deliberately never had a bypass.

    // Verify OTP via Edge Function (validates against otp_codes table, creates session)
    const { data, error } = await supabase.functions.invoke('verify-otp', {
      body: { phone, code: token },
    });

    if (error) {
      // supabase-js wraps non-2xx EF responses in a FunctionsHttpError with the raw
      // Response on `context`. Surface the EF's stable `reason` (expired / invalid /
      // too_many_attempts) on `.code` so the UI can show a precise message instead
      // of a generic one. Fall back to the raw error when the body is unreadable.
      let reason: string | null = null;
      let efMsg: string | null = null;
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) {
        try {
          const body = await ctx.clone().json();
          if (typeof body?.reason === 'string') reason = body.reason;
          if (typeof body?.error === 'string') efMsg = body.error;
        } catch {
          /* body unreadable/consumed — fall through to the raw error */
        }
      }
      if (reason || efMsg) {
        const e = new Error(efMsg ?? reason ?? 'Verification failed') as Error & { code?: string };
        if (reason) e.code = reason;
        throw e;
      }
      throw error;
    }
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

    // RN-safe upload via FormData (fetch+blob fails on Android — see _storage-upload.ts).
    await uploadFileFromUri('avatars', filePath, fileUri, {
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      upsert: true,
    });

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
   * Sign out the current user ON THIS DEVICE ONLY.
   *
   * The `scope: 'local'` is load-bearing and must stay explicit.
   * `supabase.auth.signOut()` defaults to `scope: 'global'`
   * (verified in @supabase/auth-js 2.99.1,
   * `GoTrueClient.js:1745` — `async signOut(options = { scope:
   * 'global' })`), which terminates EVERY session the user has.
   * This method backs the ordinary "Cerrar sesión" button, so the
   * default made logging out of the web also kick the phone —
   * for a driver, mid-shift and with no explanation. Use
   * `signOutAllDevices()` when the user actually asked for that.
   *
   * CC-01 (security audit 2026-05-23, mig 00297): we also call
   * `revoke_user_tokens()` to write a server-side revocation
   * timestamp, intended to close the ~1h window where a captured
   * JWT stays server-valid post-logout.
   *
   * NOTE: that revocation is currently INERT. `revoke_user_tokens`
   * only upserts a row into `auth_revocations`, and the only
   * reader — `is_session_revoked()` — has zero callers: no RPC and
   * no RLS policy references it (verified against production
   * 2026-07-25). The call is kept because it costs nothing, still
   * records an audit trail, and starts working the moment
   * `is_session_revoked()` is wired into RLS. Do not mistake it for
   * an active control.
   *
   * The revoke call is best-effort: if the RPC fails (network,
   * migration not yet deployed, transient DB error), we still
   * complete the signOut so the user UX isn't blocked.
   */
  async signOut() {
    const supabase = getSupabaseClient();

    await this._recordRevocation('user_signout');

    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
  },

  /**
   * Sign out the current user on ALL devices, terminating every
   * active session server-side (all refresh tokens are destroyed).
   *
   * Backs the "Cerrar sesión en todos los dispositivos" action on
   * the devices screen — the one case where the global scope is
   * what the user actually asked for.
   *
   * Caveat worth knowing: access tokens already issued stay valid
   * until they expire (~1h), so other devices are cut off at their
   * next token refresh rather than instantly. That is a GoTrue
   * property, not something this method can tighten.
   */
  async signOutAllDevices() {
    const supabase = getSupabaseClient();

    await this._recordRevocation('user_signout_all_devices');

    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error) throw error;
  },

  /**
   * Best-effort audit row in `auth_revocations`. Never throws —
   * a failure here must not block the user from signing out.
   * See the note in `signOut()` about this being inert today.
   */
  async _recordRevocation(reason: string) {
    const supabase = getSupabaseClient();
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id) {
        await supabase.rpc('revoke_user_tokens', {
          p_user_id: user.id,
          p_reason: reason,
        });
      }
    } catch {
      // Migration may not be applied yet (frontend-tolerant);
      // or transient error. The signOut still runs.
    }
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
   * Native Sign in with Apple (iOS only).
   *
   * Exchanges the identity token from the native Apple sheet
   * (expo-apple-authentication's `signInAsync`) for a Supabase session via
   * `signInWithIdToken`. This is the flow Apple REQUIRES on iOS (the native
   * AuthenticationServices sheet) — NOT the web OAuth redirect used by
   * `signInWithApple` (which Apple rejects for native apps under Guideline 4.0).
   *
   * The native `AppleAuthentication.signInAsync()` call lives in the app layer
   * (expo-apple-authentication is a native module, unavailable in this
   * platform-agnostic package); this method only performs the Supabase
   * exchange. Supabase verifies the token against Apple's public keys, so the
   * Apple provider must be enabled with the app bundle IDs as Client IDs.
   */
  async signInWithAppleIdToken(identityToken: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: identityToken,
    });
    if (error) throw error;
    return data;
  },

  /**
   * Link a phone number to the current OAuth account.
   * Used after social login when user needs to verify their phone.
   *
   * Sends the OTP through the `send-sms-otp` Edge Function (D7 Networks) —
   * the SAME chain as the login OTP. It must NOT use
   * `supabase.auth.updateUser({ phone })`: that triggers GoTrue's native
   * phone_change SMS via Twilio, which does not deliver to Cuba (+53).
   * D7 is the sole SMS provider since PR #462.
   */
  async linkPhone(phone: string) {
    const supabase = getSupabaseClient();

    // Send OTP via Edge Function (D7 SMS → otp_codes), same as sendOTP.
    // No __DEV__ bypass here: verifyPhoneLink validates against otp_codes
    // (no password-login fallback like verifyOTP has), so skipping the send
    // would make the link flow unverifiable in dev.
    const { data, error } = await supabase.functions.invoke('send-sms-otp', {
      body: { phone },
    });

    if (error) {
      // Surface rate-limit (429) as a typed error so the UI can show a clear
      // "too many requests, wait N" message instead of a generic failure.
      const rl = await asRateLimitError(error);
      if (rl) throw rl;
      throw error;
    }
    if (data?.error) throw new Error(data.error);
  },

  /**
   * Verify phone link OTP.
   *
   * Validates the code through the `link-phone` Edge Function, which checks
   * it against otp_codes (`verify_cuba_otp` — the same source send-sms-otp
   * writes and verify-otp reads), rejects phones owned by another active
   * account (PHONE_TAKEN), and links the phone server-side (auth.users with
   * phone_confirm + public.users mirror). Replaces
   * `supabase.auth.verifyOtp({ type: 'phone_change' })`, which only works
   * with GoTrue-sent SMS (Twilio — undeliverable to +53; see linkPhone).
   */
  async verifyPhoneLink(phone: string, token: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('link-phone', {
      body: { phone, code: token },
    });

    if (error) {
      // supabase-js wraps non-2xx EF responses in a FunctionsHttpError with
      // the raw Response on `context` — surface the EF's stable error code
      // (INVALID_CODE / PHONE_TAKEN / ...) with a clear message when readable.
      let efCode: string | null = null;
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) {
        try {
          const body = await ctx.clone().json();
          if (typeof body?.error === 'string') efCode = body.error;
        } catch {
          /* body unreadable/consumed — fall through to the raw error */
        }
      }
      if (efCode) {
        const message =
          efCode === 'INVALID_CODE'
            ? 'Invalid or expired code'
            : efCode === 'PHONE_TAKEN'
              ? 'Phone number already in use by another account'
              : efCode;
        const e = new Error(message) as Error & { code: string };
        e.code = efCode;
        throw e;
      }
      throw error;
    }
    if (data?.error || data?.success !== true) {
      throw new Error(typeof data?.error === 'string' ? data.error : 'Phone link failed');
    }
    return data;
  },

  /**
   * Promote the profile email to a REAL auth identity (backup way in).
   *
   * Phone-only accounts carry a synthetic `phone_<n>@tricigo.app` in
   * auth.users, so a correo typed into the profile screen only ever landed in
   * public.users — cosmetic, useless for signing in. Measured 2026-08-16: 63 of
   * 90 drivers had a real address stored that way, and during the 15h SMS
   * outage of 2026-08-15 not one of them could use it.
   *
   * The `add-email-with-verification` Edge Function (deployed, and with zero
   * callers until now) does the real work: writes auth.users.email and sends a
   * magic link so the address is confirmed before it counts.
   *
   * SAFE FOR PHONE LOGIN: replacing the synthetic address does NOT strand the
   * user, because `lookup_auth_user_by_contact` (used by verify-otp) matches on
   * phone OR email and *prefers* the phone — and all 350 phone-origin accounts
   * have a confirmed auth.users.phone.
   *
   * Errors surface the EF's stable codes so the UI can explain itself:
   * `email_already_taken`, `invalid_email`, `unauthorized`.
   */
  async addBackupEmail(email: string) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('add-email-with-verification', {
      body: { email },
    });

    if (error) {
      // supabase-js wraps non-2xx EF responses in a FunctionsHttpError with the
      // raw Response on `context` — same unwrapping as verifyPhoneLink above.
      let efCode: string | null = null;
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx) {
        try {
          const body = await ctx.clone().json();
          if (typeof body?.error === 'string') efCode = body.error;
        } catch {
          /* body unreadable/consumed — fall through to the raw error */
        }
      }
      if (efCode) {
        const e = new Error(efCode) as Error & { code: string };
        e.code = efCode;
        throw e;
      }
      throw error;
    }

    if (data?.error || data?.success !== true) {
      const code = typeof data?.error === 'string' ? data.error : 'add_email_failed';
      const e = new Error(code) as Error & { code: string };
      e.code = code;
      throw e;
    }
    return data;
  },

  /**
   * Ask for a sign-in link by email — the way in when SMS is down.
   *
   * Only works for accounts whose email was promoted to a real identity first
   * (see addBackupEmail). The link lands on `<scheme>://auth/callback`, which
   * useAuthDeepLink() already handles for the Google flow, so the session is set
   * by the same path.
   *
   * ANTI-ENUMERATION: the Edge Function answers `{success:true}` whether or not
   * the account exists, so callers MUST NOT treat the response as proof that an
   * email is registered — show the same "revisá tu correo" either way.
   *
   * `app` picks the redirect server-side (driver | client | web); the URL is
   * never accepted from the client, since a free redirect would leak the tokens
   * that ride in the link's fragment.
   */
  async sendEmailLoginLink(email: string, app: 'driver' | 'client' | 'web') {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.functions.invoke('send-login-email-link', {
      body: { email, app },
    });

    if (error) {
      const rl = await asRateLimitError(error);
      if (rl) throw rl;
      throw error;
    }
    if (data?.error) {
      const e = new Error(String(data.error)) as Error & { code: string };
      e.code = String(data.error);
      throw e;
    }
    return data;
  },
};
