import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The upload itself (uploadFileFromUri → storage-upload Edge Function) is
// mocked: what is tested is what this module asks of it.
const uploadFileFromUri = vi.fn(async (..._args: unknown[]) => undefined);
const getPublicUrl = vi.fn((path: string) => ({
  data: { publicUrl: `https://storage.test/dispute-evidence/${path}` },
}));
const storageFrom = vi.fn((_bucket: string) => ({ getPublicUrl }));
vi.mock('@tricigo/api', () => ({
  uploadFileFromUri: (...a: unknown[]) => uploadFileFromUri(...a),
  getSupabaseClient: () => ({ storage: { from: (bucket: string) => storageFrom(bucket) } }),
}));

import { uploadDisputeEvidence } from '../disputeEvidence';

const PHOTO_A = 'file:///cache/ImageManipulator/a.jpg';
const PHOTO_B = 'file:///cache/ImageManipulator/b.png';

describe('uploadDisputeEvidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads each photo to its own file in the uploader folder of the ride', async () => {
    await uploadDisputeEvidence('ride-1', 'user-1', [PHOTO_A, PHOTO_B]);

    const ts = Date.now();
    expect(uploadFileFromUri).toHaveBeenCalledTimes(2);
    expect(uploadFileFromUri).toHaveBeenNthCalledWith(
      1,
      'dispute-evidence',
      `disputes/ride-1/user-1/${ts}_0.jpg`,
      PHOTO_A,
      expect.objectContaining({ fileName: `${ts}_0.jpg`, mimeType: 'image/jpg' }),
    );
    expect(uploadFileFromUri).toHaveBeenNthCalledWith(
      2,
      'dispute-evidence',
      `disputes/ride-1/user-1/${ts}_1.png`,
      PHOTO_B,
      expect.objectContaining({ fileName: `${ts}_1.png`, mimeType: 'image/png' }),
    );
  });

  // After a timeout or a network error, uploadFileFromUri retries once with the
  // same path. When the first attempt did reach Storage, an upload without
  // upsert fails on its own photo with 409, and the rider gets an error for a
  // photo that was saved.
  it('uploads with upsert, so a retry can rewrite the photo its first attempt saved', async () => {
    await uploadDisputeEvidence('ride-1', 'user-1', [PHOTO_A, PHOTO_B]);

    expect(uploadFileFromUri).toHaveBeenCalledTimes(2);
    for (const call of uploadFileFromUri.mock.calls) {
      expect(call[3]).toMatchObject({ upsert: true });
    }
  });

  it('returns the public URL of each photo, in order', async () => {
    const urls = await uploadDisputeEvidence('ride-1', 'user-1', [PHOTO_A, PHOTO_B]);

    const ts = Date.now();
    expect(storageFrom).toHaveBeenCalledWith('dispute-evidence');
    expect(urls).toEqual([
      `https://storage.test/dispute-evidence/disputes/ride-1/user-1/${ts}_0.jpg`,
      `https://storage.test/dispute-evidence/disputes/ride-1/user-1/${ts}_1.png`,
    ]);
  });
});
