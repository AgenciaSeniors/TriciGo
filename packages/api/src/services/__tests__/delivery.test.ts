import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UUID } from './helpers/mockSupabase';

// uploadDeliveryPhoto routes through the dedicated `upload-delivery-photo` Edge
// Function (service-role): the EF authenticates the caller, verifies they are
// the ride's driver, uploads to the public delivery-photos bucket, records the
// URL on delivery_details, and returns the public URL. The client only invokes
// the EF (multipart FormData with ride_id + phase) and returns its publicUrl.
const mockFunctionsInvoke = vi.fn();
const mockSupabase = { functions: { invoke: mockFunctionsInvoke } };
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
    mockFunctionsInvoke.mockResolvedValue({ data: { publicUrl: PUBLIC_URL }, error: null });
  });

  it('invokes the upload-delivery-photo EF with ride_id + phase as multipart FormData', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery');

    expect(mockFunctionsInvoke).toHaveBeenCalledWith('upload-delivery-photo', {
      body: expect.any(FormData),
    });
    const body = mockFunctionsInvoke.mock.calls[0][1].body as FormData;
    expect(body.get('ride_id')).toBe(RIDE);
    expect(body.get('phase')).toBe('delivery');
  });

  it('passes the pickup phase through', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'pickup');
    const body = mockFunctionsInvoke.mock.calls[0][1].body as FormData;
    expect(body.get('phase')).toBe('pickup');
  });

  it('returns the public URL reported by the EF', async () => {
    const url = await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery');
    expect(url).toBe(PUBLIC_URL);
  });

  it('throws when the EF returns a gateway error', async () => {
    mockFunctionsInvoke.mockResolvedValueOnce({ data: null, error: new Error('not the ride driver') });
    await expect(
      deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery'),
    ).rejects.toThrow('not the ride driver');
  });

  it('throws when the EF body carries an error', async () => {
    mockFunctionsInvoke.mockResolvedValueOnce({ data: { error: 'upload failed' }, error: null });
    await expect(
      deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'delivery'),
    ).rejects.toThrow('upload failed');
  });
});
