import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { motoDeportivaService } from '../moto-deportiva.service';

describe('motoDeportivaService', () => {
  beforeEach(() => mockRpc.mockReset());

  it('getStatus returns null when the RPC is missing', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    expect(await motoDeportivaService.getStatus()).toBeNull();
  });
  it('getStatus parses the RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'available', waiting: false }, error: null });
    expect(await motoDeportivaService.getStatus()).toEqual({ status: 'available', waiting: false });
  });
  it('removeSubscriber throws AppError on forbidden', async () => {
    mockRpc.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
    await expect(motoDeportivaService.removeSubscriber('u1')).rejects.toMatchObject({ code: 'MOTO_DEPORTIVA_FORBIDDEN' });
  });
});
