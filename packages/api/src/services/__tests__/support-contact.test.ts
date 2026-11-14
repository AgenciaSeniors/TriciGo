import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
}));

import { supportContactService } from '../support-contact.service';

const MISSING = { code: 'PGRST202', message: 'Could not find the function public.get_support_contact' };

describe('supportContactService.fetch', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('maps the phone', async () => {
    mockRpc.mockResolvedValueOnce({ data: { phone: '+5355123456' }, error: null });
    await expect(supportContactService.fetch()).resolves.toEqual({ status: 'ok', phone: '+5355123456' });
    expect(mockRpc).toHaveBeenCalledWith('get_support_contact');
  });

  it('answers ok with no phone when the server has nobody to offer', async () => {
    mockRpc.mockResolvedValueOnce({ data: { phone: null }, error: null });
    await expect(supportContactService.fetch()).resolves.toEqual({ status: 'ok', phone: null });
  });

  it('is unreachable when the function is missing, the server errors, or the network fails', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: MISSING });
    await expect(supportContactService.fetch()).resolves.toEqual({ status: 'unreachable' });
    mockRpc.mockResolvedValueOnce({ data: { error: 'forbidden' }, error: null });
    await expect(supportContactService.fetch()).resolves.toEqual({ status: 'unreachable' });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(supportContactService.fetch()).resolves.toEqual({ status: 'unreachable' });
    mockRpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(supportContactService.fetch()).resolves.toEqual({ status: 'unreachable' });
  });
});
