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

  it('throws when the Edge Function returns a gateway error', async () => {
    const uploadErr = { message: 'Network request failed', code: '500' };
    mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: uploadErr });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toEqual(uploadErr);
  });

  it('throws when the Edge Function body carries an error', async () => {
    mockFunctionsInvoke.mockResolvedValueOnce({ data: { error: 'bucket not allowed' }, error: null });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toThrow('bucket not allowed');
  });
});
