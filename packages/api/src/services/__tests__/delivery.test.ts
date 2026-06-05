import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UUID } from './helpers/mockSupabase';

// Mock the RN-safe storage upload helper so we can assert the bucket + path
// contract that uploadDeliveryPhoto must satisfy for the storage RLS policy.
const mockUploadFileFromUri = vi.fn();
// Lazy factory (arrow captures the binding, read only at call time) — mirrors
// the auth.test.ts pattern and avoids the vi.mock hoisting ReferenceError.
vi.mock('../_storage-upload', () => ({
  uploadFileFromUri: (...args: unknown[]) => mockUploadFileFromUri(...args),
}));

// Mock the Supabase client (getPublicUrl + delivery_details update).
const mockGetPublicUrl = vi.fn();
const mockStorageFrom = vi.fn(() => ({ getPublicUrl: mockGetPublicUrl }));
const mockEq = vi.fn(() => Promise.resolve({ error: null }));
const mockUpdate = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ update: mockUpdate }));
const mockSupabase = { storage: { from: mockStorageFrom }, from: mockFrom };
vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mocks are set up.
import { deliveryService } from '../delivery.service';

const RIDE = UUID.RIDE_1;
const LOCAL_URI = 'file:///tmp/photo.jpg';
const PUBLIC_URL = 'https://example.supabase.co/storage/v1/object/public/delivery-photos/x.jpg';

describe('deliveryService.uploadDeliveryPhoto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadFileFromUri.mockResolvedValue(undefined);
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: PUBLIC_URL } });
  });

  it('uploads to the public "delivery-photos" bucket with the ride id as the first path segment', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery');

    expect(mockUploadFileFromUri).toHaveBeenCalledTimes(1);
    const [bucket, storagePath] = mockUploadFileFromUri.mock.calls[0];
    // Must target the dedicated public bucket, NOT 'driver-documents'.
    expect(bucket).toBe('delivery-photos');
    // Path's first folder must be the ride id (satisfies delivery_photos_insert
    // policy: foldername[1] = rides.id). The legacy 'delivery-photos/' prefix is gone.
    expect(storagePath).toMatch(new RegExp(`^${RIDE}/`));
    expect(storagePath).not.toContain('delivery-photos/');
  });

  it('reads the public URL from the "delivery-photos" bucket', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery');
    expect(mockStorageFrom).toHaveBeenCalledWith('delivery-photos');
  });

  it('writes delivery_photo_url for the delivery phase', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery');
    expect(mockUpdate).toHaveBeenCalledWith({ delivery_photo_url: PUBLIC_URL });
  });

  it('writes pickup_photo_url for the pickup phase', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'pickup');
    expect(mockUpdate).toHaveBeenCalledWith({ pickup_photo_url: PUBLIC_URL });
  });
});
