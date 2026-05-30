import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase storage client.
const mockStorageUpload = vi.fn();
const mockStorageFrom = vi.fn(() => ({ upload: mockStorageUpload }));
const mockSupabase = { storage: { from: mockStorageFrom } };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after the mock is set up.
import { uploadFileFromUri } from '../_storage-upload';

describe('uploadFileFromUri', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads via FormData with multipart content-type (not fetch+blob)', async () => {
    mockStorageUpload.mockResolvedValueOnce({ error: null });

    await uploadFileFromUri('driver-documents', 'path/to/file.jpg', 'file:///tmp/file.jpg', {
      fileName: 'file.jpg',
      mimeType: 'image/jpeg',
      upsert: true,
    });

    expect(mockStorageFrom).toHaveBeenCalledWith('driver-documents');
    expect(mockStorageUpload).toHaveBeenCalledWith(
      'path/to/file.jpg',
      expect.any(FormData),
      { contentType: 'multipart/form-data', upsert: true },
    );
  });

  it('defaults upsert to false and mimeType to image/jpeg', async () => {
    mockStorageUpload.mockResolvedValueOnce({ error: null });

    await uploadFileFromUri('dispute-evidence', 'disputes/r1/u1/p.png', 'file:///tmp/p.png', {
      fileName: 'p.png',
    });

    expect(mockStorageFrom).toHaveBeenCalledWith('dispute-evidence');
    expect(mockStorageUpload).toHaveBeenCalledWith(
      'disputes/r1/u1/p.png',
      expect.any(FormData),
      { contentType: 'multipart/form-data', upsert: false },
    );
  });

  it('throws when the storage upload returns an error', async () => {
    const uploadErr = { message: 'Network request failed', code: '500' };
    mockStorageUpload.mockResolvedValueOnce({ error: uploadErr });

    await expect(
      uploadFileFromUri('driver-documents', 'p', 'file:///x.jpg', { fileName: 'x.jpg' }),
    ).rejects.toEqual(uploadErr);
  });
});
