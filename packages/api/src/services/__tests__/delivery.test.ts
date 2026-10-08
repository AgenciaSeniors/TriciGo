import { describe, it, expect, vi, beforeEach, assert } from 'vitest';
import { UUID, createMockQueryChain } from './helpers/mockSupabase';

// uploadDeliveryPhoto routes through the dedicated `upload-delivery-photo` Edge
// Function (service-role): the EF authenticates the caller, verifies they are
// the ride's driver, uploads to the public delivery-photos bucket, records the
// URL on delivery_details, and returns the public URL. The client only invokes
// the EF (multipart FormData with ride_id + phase) and returns its publicUrl.
const mockFunctionsInvoke = vi.fn();
const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSupabase = {
  functions: { invoke: mockFunctionsInvoke },
  rpc: mockRpc,
  from: mockFrom,
};
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
    const call = mockFunctionsInvoke.mock.calls[0];
    assert(call);
    const body = call[1].body as FormData;
    expect(body.get('ride_id')).toBe(RIDE);
    expect(body.get('phase')).toBe('delivery');
  });

  it('passes the pickup phase through', async () => {
    await deliveryService.uploadDeliveryPhoto(RIDE, LOCAL_URI, 'pickup');
    const call = mockFunctionsInvoke.mock.calls[0];
    assert(call);
    const body = call[1].body as FormData;
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

// 00511 — the driver must never read `delivery_otp`: it is the code the
// recipient dictates at drop-off, and reading it off their own screen would
// defeat trg_rides_require_delivery_proof and the +5% cargo bonus. The masking
// is enforced server-side by the RPC; what these tests pin down is that the
// client actually GOES through the RPC (and not back to `select('*')`, which
// would return every column to whoever RLS lets in).
describe('deliveryService.getDeliveryDetails', () => {
  const ROW = {
    id: UUID.DOC_1,
    ride_id: RIDE,
    package_description: 'Sobre con documentos',
    recipient_name: 'Ana',
    recipient_phone: '+5355551234',
    delivery_otp: null,
    delivery_otp_validated_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: [ROW], error: null });
  });

  it('reads through the role-scoped RPC, not the table', async () => {
    await deliveryService.getDeliveryDetails(RIDE);

    expect(mockRpc).toHaveBeenCalledWith('get_delivery_details_for_ride', {
      p_ride_id: RIDE,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('unwraps the first row of the RETURNS TABLE result set', async () => {
    const result = await deliveryService.getDeliveryDetails(RIDE);
    expect(result).toEqual(ROW);
  });

  it('returns null when the caller has no role on the ride (zero rows)', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await deliveryService.getDeliveryDetails(RIDE)).toBeNull();
  });

  it('returns null when the RPC yields no data at all', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await deliveryService.getDeliveryDetails(RIDE)).toBeNull();
  });

  // A build can ship ahead of migration 00511. When it does, the old direct
  // read must still work rather than the cargo screens going blank.
  it('falls back to the direct table read when the RPC is absent (42883)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'boom' } });
    const chain = createMockQueryChain({ data: ROW, error: null });
    mockFrom.mockReturnValueOnce(chain);

    const result = await deliveryService.getDeliveryDetails(RIDE);

    expect(mockFrom).toHaveBeenCalledWith('delivery_details');
    expect(chain.eq).toHaveBeenCalledWith('ride_id', RIDE);
    expect(result).toEqual(ROW);
  });

  it('falls back when the error only carries the message, without the code', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: undefined, message: 'function get_delivery_details_for_ride does not exist' },
    });
    mockFrom.mockReturnValueOnce(createMockQueryChain({ data: ROW, error: null }));

    expect(await deliveryService.getDeliveryDetails(RIDE)).toEqual(ROW);
  });

  it('propagates a real RPC failure instead of silently falling back', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '57014', message: 'statement timeout' },
    });

    await expect(deliveryService.getDeliveryDetails(RIDE)).rejects.toThrow('statement timeout');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('propagates an error raised by the fallback read', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'boom' } });
    mockFrom.mockReturnValueOnce(
      createMockQueryChain({ data: null, error: { message: 'permission denied' } }),
    );

    await expect(deliveryService.getDeliveryDetails(RIDE)).rejects.toThrow('permission denied');
  });
});

// 00644: riders no longer read other drivers' vehicles (plates, photos). The
// delivery selector gets per-type capabilities from get_cargo_vehicle_caps,
// which returns no plate, photo or driver id.
describe('deliveryService.getCargoVehicleCaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the aggregated capabilities from get_cargo_vehicle_caps', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        { vehicle_type: 'moto', max_weight_kg: '15.5', max_length_cm: 60, max_width_cm: 40, max_height_cm: 40,
          accepted_categories: ['documentos', 'comida'], available_count: 12 },
        { vehicle_type: 'auto', max_weight_kg: null, max_length_cm: null, max_width_cm: null, max_height_cm: null,
          accepted_categories: null, available_count: 3 },
      ],
      error: null,
    });

    const caps = await deliveryService.getCargoVehicleCaps();

    expect(mockRpc).toHaveBeenCalledWith('get_cargo_vehicle_caps');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(caps).toEqual([
      { type: 'moto', maxWeightKg: 15.5, maxLengthCm: 60, maxWidthCm: 40, maxHeightCm: 40,
        acceptedCategories: ['documentos', 'comida'], availableCount: 12 },
      { type: 'auto', maxWeightKg: null, maxLengthCm: null, maxWidthCm: null, maxHeightCm: null,
        acceptedCategories: [], availableCount: 3 },
    ]);
  });

  it('falls back to aggregating the vehicles table while the function is missing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const chain = createMockQueryChain({
      data: [
        { type: 'moto', max_cargo_weight_kg: 10, max_cargo_length_cm: 50, max_cargo_width_cm: null, max_cargo_height_cm: 30, accepted_cargo_categories: ['documentos'] },
        { type: 'moto', max_cargo_weight_kg: 20, max_cargo_length_cm: 40, max_cargo_width_cm: 35, max_cargo_height_cm: null, accepted_cargo_categories: ['comida', 'documentos'] },
        { type: 'triciclo', max_cargo_weight_kg: null, max_cargo_length_cm: null, max_cargo_width_cm: null, max_cargo_height_cm: null, accepted_cargo_categories: null },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(chain);

    const caps = await deliveryService.getCargoVehicleCaps();

    expect(mockFrom).toHaveBeenCalledWith('vehicles');
    expect(chain.eq).toHaveBeenCalledWith('accepts_cargo', true);
    expect(chain.eq).toHaveBeenCalledWith('is_active', true);
    expect(caps).toEqual([
      { type: 'moto', maxWeightKg: 20, maxLengthCm: 50, maxWidthCm: 35, maxHeightCm: 30,
        acceptedCategories: ['documentos', 'comida'], availableCount: 2 },
      { type: 'triciclo', maxWeightKg: null, maxLengthCm: null, maxWidthCm: null, maxHeightCm: null,
        acceptedCategories: [], availableCount: 1 },
    ]);
  });

  it('throws any other error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied for function get_cargo_vehicle_caps' } });
    await expect(deliveryService.getCargoVehicleCaps()).rejects.toThrow('permission denied');
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
