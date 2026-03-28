import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockFunctionsInvoke = vi.fn();
const mockAuth = {
  getSession: vi.fn(),
  getUser: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
};
const mockFrom = vi.fn();
const mockStorageUpload = vi.fn();
const mockStorageGetPublicUrl = vi.fn();
const mockStorage = {
  from: vi.fn(() => ({
    upload: mockStorageUpload,
    getPublicUrl: mockStorageGetPublicUrl,
  })),
};
const mockSupabase = {
  auth: mockAuth,
  from: mockFrom,
  storage: mockStorage,
  functions: { invoke: mockFunctionsInvoke },
};

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
    it('calls send-email-otp edge function with email', async () => {
      mockFunctionsInvoke.mockResolvedValue({ data: { success: true }, error: null });

      await authService.sendOTP('user@example.com');

      expect(mockFunctionsInvoke).toHaveBeenCalledWith('send-email-otp', {
        body: { email: 'user@example.com' },
      });
    });

    it('throws on edge function error', async () => {
      const err = new Error('Function invocation failed');
      mockFunctionsInvoke.mockResolvedValue({ data: null, error: err });

      await expect(authService.sendOTP('user@example.com')).rejects.toEqual(err);
    });

    it('throws on data error', async () => {
      mockFunctionsInvoke.mockResolvedValue({ data: { error: 'Rate limited' }, error: null });

      await expect(authService.sendOTP('user@example.com')).rejects.toThrow('Rate limited');
    });
  });

  // ==================== verifyOTP ====================
  describe('verifyOTP', () => {
    it('calls verify-whatsapp-otp edge function with email and code', async () => {
      const mockSession = { access_token: 'tok-123', refresh_token: 'ref-123' };
      mockFunctionsInvoke.mockResolvedValue({
        data: { success: true, session: mockSession },
        error: null,
      });
      mockAuth.setSession.mockResolvedValue({ data: {}, error: null });

      const result = await authService.verifyOTP('user@example.com', '123456');

      expect(mockFunctionsInvoke).toHaveBeenCalledWith('verify-whatsapp-otp', {
        body: { email: 'user@example.com', code: '123456' },
      });
      expect(mockAuth.setSession).toHaveBeenCalledWith({
        access_token: 'tok-123',
        refresh_token: 'ref-123',
      });
      expect(result.session).toEqual(mockSession);
    });

    it('throws on edge function error', async () => {
      const err = new Error('Invocation failed');
      mockFunctionsInvoke.mockResolvedValue({ data: null, error: err });

      await expect(authService.verifyOTP('user@example.com', '000000')).rejects.toEqual(err);
    });

    it('throws on data error', async () => {
      mockFunctionsInvoke.mockResolvedValue({ data: { error: 'Invalid or expired code' }, error: null });

      await expect(authService.verifyOTP('user@example.com', '000000')).rejects.toThrow('Invalid or expired code');
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

      const mockProfile = { id: 'u-1', full_name: 'Test User', email: 'test@example.com' };
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

  // ==================== getAuthUserMetadata ====================
  describe('getAuthUserMetadata', () => {
    it('returns user metadata from auth user', async () => {
      const metadata = { name: 'John', picture: 'https://example.com/photo.jpg' };
      mockAuth.getUser.mockResolvedValue({
        data: { user: { id: 'u-1', user_metadata: metadata } },
      });

      const result = await authService.getAuthUserMetadata();
      expect(result).toEqual(metadata);
    });

    it('returns null when no auth user', async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: null },
      });

      const result = await authService.getAuthUserMetadata();
      expect(result).toBeNull();
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
      mockAuth.signOut.mockResolvedValue({ error: null });

      await authService.signOut();

      expect(mockAuth.signOut).toHaveBeenCalled();
    });

    it('throws on supabase error', async () => {
      const err = { message: 'Sign out failed', code: '500' };
      mockAuth.signOut.mockResolvedValue({ error: err });

      await expect(authService.signOut()).rejects.toEqual(err);
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

  // ==================== uploadAvatar ====================
  describe('uploadAvatar', () => {
    beforeEach(() => {
      // Mock global fetch for blob conversion
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        blob: vi.fn().mockResolvedValue(new Blob(['test'], { type: 'image/jpeg' })),
      }));
    });

    it('uploads image to storage and updates profile', async () => {
      mockStorageUpload.mockResolvedValue({ error: null });
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

      expect(mockStorage.from).toHaveBeenCalledWith('avatars');
      expect(mockStorageUpload).toHaveBeenCalledWith(
        'user-1/avatar.jpg',
        expect.any(Blob),
        { contentType: 'image/jpeg', upsert: true },
      );
      expect(result).toContain('https://storage.supabase.co/avatars/user-1/avatar.jpg');
    });

    it('throws on storage upload error', async () => {
      mockStorageUpload.mockResolvedValue({ error: new Error('Storage full') });

      await expect(authService.uploadAvatar('user-1', 'file:///tmp/photo.jpg')).rejects.toThrow('Storage full');
    });
  });
});
