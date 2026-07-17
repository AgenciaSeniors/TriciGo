import { describe, it, expect, vi, beforeEach } from 'vitest';

// uploadFileFromUri routes the upload through the `storage-upload` Edge Function
// (service-role) via `functions.invoke`, NOT a direct `supabase.storage.upload()`
// — since the publishable-key migration the Storage service rejects the user JWT
// (treats it as anon). See _storage-upload.ts / PR #430/#432.
const mockFunctionsInvoke = vi.fn();
const mockSupabase = { functions: { invoke: mockFunctionsInvoke } };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after the mock is set up.
import { uploadFileFromUri } from '../_storage-upload';

describe('uploadFileFromUri', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFunctionsInvoke.mockResolvedValue({ data: { path: 'ok' }, error: null });
  });

  it('posts FormData (bucket/path/upsert/contentType) to the storage-upload EF', async () => {
    await uploadFileFromUri('driver-documents', 'path/to/file.jpg', 'file:///tmp/file.jpg', {
      fileName: 'file.jpg',
      mimeType: 'image/jpeg',
      upsert: true,
    });

    expect(mockFunctionsInvoke).toHaveBeenCalledWith('storage-upload', {
      body: expect.any(FormData),
    });
    const body = mockFunctionsInvoke.mock.calls[0][1].body as FormData;
    expect(body.get('bucket')).toBe('driver-documents');
    expect(body.get('path')).toBe('path/to/file.jpg');
    expect(body.get('upsert')).toBe('true');
    expect(body.get('contentType')).toBe('image/jpeg');
  });

  it('defaults upsert to false and omits contentType when no mimeType is given', async () => {
    await uploadFileFromUri('dispute-evidence', 'disputes/r1/u1/p.png', 'file:///tmp/p.png', {
      fileName: 'p.png',
    });

    const body = mockFunctionsInvoke.mock.calls[0][1].body as FormData;
    expect(body.get('bucket')).toBe('dispute-evidence');
    expect(body.get('upsert')).toBe('false');
    expect(body.get('contentType')).toBeNull();
  });

  it('falls back to error.message on a gateway error with no JSON body', async () => {
    // A gateway-level failure (no EF response body) → use error.message.
    const uploadErr = { message: 'Network request failed', code: '500' };
    mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: uploadErr });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toThrow('Network request failed');
  });

  it('surfaces the EF { error, reason } body from a non-2xx (error.context)', async () => {
    // On a 503 the EF returns { error:'db_error', reason:'...' }; supabase-js puts
    // the parsed body on error.context. The thrown Error must carry that reason so
    // a DB/connection blip is diagnosable instead of an opaque non-2xx message.
    const httpErr = {
      message: 'Edge Function returned a non-2xx status code',
      context: {
        json: async () => ({ error: 'db_error', reason: 'statement timeout' }),
      },
    };
    mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: httpErr });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toThrow('db_error: statement timeout');
  });

  it('uses just the code when the EF body has an error but no reason (forbidden)', async () => {
    // A genuine authorization denial returns a bare { error:'forbidden' } (no
    // reason) — no authz detail is leaked.
    const httpErr = {
      message: 'Edge Function returned a non-2xx status code',
      context: { json: async () => ({ error: 'forbidden' }) },
    };
    mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: httpErr });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toThrow('forbidden');
  });

  it('throws when the Edge Function body carries an error (2xx with { error })', async () => {
    mockFunctionsInvoke.mockResolvedValueOnce({ data: { error: 'bucket not allowed' }, error: null });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toThrow('bucket not allowed');
  });

  // ── Timeout + retry (Cuban connectivity) ────────────────────────────────────
  // uploadFileFromUri races each invoke against a hard timeout and auto-retries
  // once on a timeout/network-class failure, but never on a real EF denial.

  it('retries once and succeeds after a transient network error', async () => {
    vi.useFakeTimers();
    try {
      // A real supabase-js network failure is a FunctionsFetchError (has `name`).
      const netErr = { name: 'FunctionsFetchError', message: 'Failed to send a request' };
      mockFunctionsInvoke
        .mockResolvedValueOnce({ data: null, error: netErr })
        .mockResolvedValueOnce({ data: { path: 'ok' }, error: null });

      const p = uploadFileFromUri('avatars', 'u/avatar.jpg', 'file:///a.jpg', {
        fileName: 'avatar.jpg',
        upsert: true,
      });
      // Advance past the retry backoff so attempt #2 runs.
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(p).resolves.toBeUndefined();
      expect(mockFunctionsInvoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a stalled upload, then retries and succeeds', async () => {
    vi.useFakeTimers();
    try {
      mockFunctionsInvoke
        .mockReturnValueOnce(new Promise(() => {})) // never resolves — a hung request
        .mockResolvedValueOnce({ data: { path: 'ok' }, error: null });

      const p = uploadFileFromUri('avatars', 'u/avatar.jpg', 'file:///a.jpg', {
        fileName: 'avatar.jpg',
        upsert: true,
      });
      // Advance past the per-attempt timeout (45s) + the retry backoff.
      await vi.advanceTimersByTimeAsync(50_000);
      await expect(p).resolves.toBeUndefined();
      expect(mockFunctionsInvoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the max attempts on a persistent network error', async () => {
    vi.useFakeTimers();
    try {
      mockFunctionsInvoke.mockResolvedValue({
        data: null,
        error: { name: 'FunctionsFetchError', message: 'network down' },
      });

      const p = uploadFileFromUri('avatars', 'u/avatar.jpg', 'file:///a.jpg', {
        fileName: 'avatar.jpg',
      });
      // Attach the rejection expectation before advancing so the eventual reject
      // is handled (no unhandled-rejection warning).
      const assertion = expect(p).rejects.toThrow('network down');
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(mockFunctionsInvoke).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry a real EF denial (forbidden)', async () => {
    const httpErr = {
      message: 'Edge Function returned a non-2xx status code',
      context: { json: async () => ({ error: 'forbidden' }) },
    };
    mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: httpErr });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toThrow('forbidden');
    expect(mockFunctionsInvoke).toHaveBeenCalledTimes(1); // no retry on a denial
  });
});
