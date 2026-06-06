import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockAuth = {
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithOAuth: vi.fn(),
  updateUser: vi.fn(),
  setSession: vi.fn(),
  signInWithPassword: vi.fn(),
};
const mockFunctions = {
  invoke: vi.fn(),
};
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockStorageUpload = vi.fn();
const mockStorageGetPublicUrl = vi.fn();
const mockStorage = {
  from: vi.fn(() => ({
    upload: mockStorageUpload,
    getPublicUrl: mockStorageGetPublicUrl,
  })),
};
const mockSupabase = { auth: mockAuth, from: mockFrom, storage: mockStorage, functions: mockFunctions, rpc: mockRpc };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { authService } from '../auth.service';

describe('authService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== sendOTP ====================
  describe('sendOTP', () => {
    it('calls supabase functions.invoke with the phone number', async () => {
      mockFunctions.invoke.mockResolvedValue({ data: { success: true }, error: null });

      await authService.sendOTP('+573001234567');

      expect(mockFunctions.invoke).toHaveBeenCalledWith('send-sms-otp', {
        body: { phone: '+573001234567' },
      });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Rate limit exceeded', code: '429' };
      mockFunctions.invoke.mockResolvedValue({ data: null, error: err });

      await expect(authService.sendOTP('+573001234567')).rejects.toEqual(err);
    });
  });

  // ==================== verifyOTP ====================
  describe('verifyOTP', () => {
    it('calls supabase functions.invoke with phone and code', async () => {
      const mockData = { session: { access_token: 'tok-123', refresh_token: 'ref-123' }, user: { id: 'u-1' } };
      mockFunctions.invoke.mockResolvedValue({ data: mockData, error: null });
      mockAuth.setSession.mockResolvedValue({ error: null });

      const result = await authService.verifyOTP('+573001234567', '123456');

      expect(mockFunctions.invoke).toHaveBeenCalledWith('verify-otp', {
        body: { phone: '+573001234567', code: '123456' },
      });
      expect(result).toEqual(mockData);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Invalid OTP', code: 'otp_expired' };
      mockFunctions.invoke.mockResolvedValue({ data: null, error: err });

      await expect(authService.verifyOTP('+573001234567', '000000')).rejects.toEqual(err);
    });
  });

  // ==================== getSession ====================
  describe('getSession', () => {
    it('returns the current session', async () => {
      const mockSession = { access_token: 'tok-abc', user: { id: 'u-1' } };
      mockAuth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      const session = await authService.getSession();

      expect(mockAuth.getSession).toHaveBeenCalled();
      expect(session).toEqual(mockSession);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Session error', code: '500' };
      mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: err });

      await expect(authService.getSession()).rejects.toEqual(err);
    });
  });

  // ==================== getCurrentUser ====================
  describe('getCurrentUser', () => {
    it('returns user profile from users table when authenticated', async () => {
      const authUser = { id: 'u-1', email: 'test@example.com' };
      mockAuth.getUser.mockResolvedValue({
        data: { user: authUser },
      });

      const mockProfile = { id: 'u-1', full_name: 'Test User', phone: '+573001234567' };
      const mockSingle = vi.fn().mockResolvedValue({ data: mockProfile, error: null });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      const user = await authService.getCurrentUser();

      expect(mockAuth.getUser).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockEq).toHaveBeenCalledWith('id', 'u-1');
      expect(user).toEqual(mockProfile);
    });

    it('returns null when no auth user exists', async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: null },
      });

      const user = await authService.getCurrentUser();

      expect(user).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('throws on supabase from error', async () => {
      const authUser = { id: 'u-1' };
      mockAuth.getUser.mockResolvedValue({
        data: { user: authUser },
      });

      const err = { message: 'DB error', code: '42P01' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockEq = vi.fn(() => ({ single: mockSingle }));
      const mockSelect = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ select: mockSelect });

      await expect(authService.getCurrentUser()).rejects.toEqual(err);
    });
  });

  // ==================== updateProfile ====================
  describe('updateProfile', () => {
    it('updates user profile and returns the updated record', async () => {
      const updated = { id: 'u-1', full_name: 'Updated Name' };
      const mockSingle = vi.fn().mockResolvedValue({ data: updated, error: null });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      const result = await authService.updateProfile('u-1', { full_name: 'Updated Name' } as any);

      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(mockUpdate).toHaveBeenCalledWith({ full_name: 'Updated Name' });
      expect(mockEq).toHaveBeenCalledWith('id', 'u-1');
      expect(mockSelect).toHaveBeenCalled();
      expect(result).toEqual(updated);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Update failed', code: '23505' };
      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: err });
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockEq = vi.fn(() => ({ select: mockSelect }));
      const mockUpdate = vi.fn(() => ({ eq: mockEq }));

      mockFrom.mockReturnValueOnce({ update: mockUpdate });

      await expect(
        authService.updateProfile('u-1', { full_name: 'Fail' } as any),
      ).rejects.toEqual(err);
    });
  });

  // ==================== signOut ====================
  describe('signOut', () => {
    it('calls supabase auth.signOut', async () => {
      mockAuth.getUser.mockResolvedValue({ data: { user: null }, error: null });
      mockAuth.signOut.mockResolvedValue({ error: null });

      await authService.signOut();

      expect(mockAuth.signOut).toHaveBeenCalled();
    });

    it('throws on supabase error', async () => {
      mockAuth.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const err = { message: 'Sign out failed', code: '500' };
      mockAuth.signOut.mockResolvedValue({ error: err });

      await expect(authService.signOut()).rejects.toEqual(err);
    });

    // CC-01 (security audit 2026-05-23, mig 00297): server-side
    // revocation via revoke_user_tokens RPC before local signOut.
    // RLS policies that consume is_session_revoked() will reject
    // subsequent requests carrying the pre-logout JWT.
    it('calls revoke_user_tokens RPC with current user id and signout reason (CC-01)', async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: { id: 'u-42' } },
        error: null,
      });
      mockRpc.mockResolvedValue({ data: { success: true }, error: null });
      mockAuth.signOut.mockResolvedValue({ error: null });

      await authService.signOut();

      expect(mockRpc).toHaveBeenCalledWith('revoke_user_tokens', {
        p_user_id: 'u-42',
        p_reason: 'user_signout',
      });
      expect(mockAuth.signOut).toHaveBeenCalled();
    });

    it('completes signOut even when revoke RPC fails (CC-01 best-effort)', async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: { id: 'u-42' } },
        error: null,
      });
      // Migration not yet applied → RPC error
      mockRpc.mockRejectedValue(new Error('function revoke_user_tokens does not exist'));
      mockAuth.signOut.mockResolvedValue({ error: null });

      await authService.signOut();

      // Local signOut still runs despite the revoke RPC failure
      expect(mockAuth.signOut).toHaveBeenCalled();
    });
  });

  // ==================== onAuthStateChange ====================
  describe('onAuthStateChange', () => {
    it('registers callback and returns subscription', () => {
      const mockSubscription = { data: { subscription: { unsubscribe: vi.fn() } } };
      mockAuth.onAuthStateChange.mockReturnValue(mockSubscription);

      const callback = vi.fn();
      const result = authService.onAuthStateChange(callback);

      expect(mockAuth.onAuthStateChange).toHaveBeenCalledWith(callback);
      expect(result).toEqual(mockSubscription);
    });
  });

  // ==================== signInWithGoogle ====================
  describe('signInWithGoogle', () => {
    it('calls supabase auth.signInWithOAuth with google provider and options', async () => {
      const mockData = { url: 'https://accounts.google.com/o/oauth2/auth?...' };
      mockAuth.signInWithOAuth.mockResolvedValue({ data: mockData, error: null });

      const result = await authService.signInWithGoogle('https://app.tricigo.com/callback');

      expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: 'https://app.tricigo.com/callback',
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      expect(result).toEqual(mockData);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'OAuth error', code: 'oauth_failed' };
      mockAuth.signInWithOAuth.mockResolvedValue({ data: null, error: err });

      await expect(authService.signInWithGoogle()).rejects.toEqual(err);
    });
  });

  // ==================== signInWithApple ====================
  describe('signInWithApple', () => {
    it('calls supabase auth.signInWithOAuth with apple provider and options', async () => {
      const mockData = { url: 'https://appleid.apple.com/auth/authorize?...' };
      mockAuth.signInWithOAuth.mockResolvedValue({ data: mockData, error: null });

      const result = await authService.signInWithApple('https://app.tricigo.com/callback');

      expect(mockAuth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'apple',
        options: {
          redirectTo: 'https://app.tricigo.com/callback',
        },
      });
      expect(result).toEqual(mockData);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Apple OAuth error', code: 'oauth_failed' };
      mockAuth.signInWithOAuth.mockResolvedValue({ data: null, error: err });

      await expect(authService.signInWithApple()).rejects.toEqual(err);
    });
  });

  // ==================== linkPhone ====================
  describe('linkPhone', () => {
    it('calls supabase auth.updateUser with the phone number', async () => {
      mockAuth.updateUser.mockResolvedValue({ error: null });

      await authService.linkPhone('+573009876543');

      expect(mockAuth.updateUser).toHaveBeenCalledWith({ phone: '+573009876543' });
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Phone already linked', code: 'phone_exists' };
      mockAuth.updateUser.mockResolvedValue({ error: err });

      await expect(authService.linkPhone('+573009876543')).rejects.toEqual(err);
    });
  });

  // ==================== verifyPhoneLink ====================
  describe('verifyPhoneLink', () => {
    it('calls supabase auth.verifyOtp with phone_change type', async () => {
      const mockData = { session: { access_token: 'tok-456' }, user: { id: 'u-1' } };
      mockAuth.verifyOtp.mockResolvedValue({ data: mockData, error: null });

      const result = await authService.verifyPhoneLink('+573009876543', '654321');

      expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
        phone: '+573009876543',
        token: '654321',
        type: 'phone_change',
      });
      expect(result).toEqual(mockData);
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Verify failed', code: 'otp_expired' };
      mockAuth.verifyOtp.mockResolvedValue({ data: null, error: err });

      await expect(authService.verifyPhoneLink('+573009876543', '000000')).rejects.toEqual(err);
    });
  });

  // ==================== uploadAvatar ====================
  //
  // Upload routes through the `storage-upload` Edge Function (service-role) via
  // uploadFileFromUri; getPublicUrl + updateProfile stay client-side. (PR #430/#432.)
  describe('uploadAvatar', () => {
    it('uploads image via the storage-upload EF and updates profile', async () => {
      mockFunctions.invoke.mockResolvedValue({ data: { path: 'user-1/avatar.jpg' }, error: null });
      mockStorageGetPublicUrl.mockReturnValue({
        data: { publicUrl: 'https://storage.supabase.co/avatars/user-1/avatar.jpg' },
      });

      // Mock updateProfile chain
      mockFrom.mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'user-1', avatar_url: 'https://storage.supabase.co/avatars/user-1/avatar.jpg' },
                error: null,
              }),
            }),
          }),
        }),
      });

      const result = await authService.uploadAvatar('user-1', 'file:///tmp/photo.jpg');

      expect(mockFunctions.invoke).toHaveBeenCalledWith('storage-upload', { body: expect.any(FormData) });
      expect(mockStorage.from).toHaveBeenCalledWith('avatars');
      expect(result).toContain('https://storage.supabase.co/avatars/user-1/avatar.jpg');
    });

    it('throws when the storage-upload EF returns an error', async () => {
      mockFunctions.invoke.mockResolvedValue({ data: null, error: new Error('Storage full') });

      await expect(authService.uploadAvatar('user-1', 'file:///tmp/photo.jpg')).rejects.toThrow('Storage full');
    });
  });
});
