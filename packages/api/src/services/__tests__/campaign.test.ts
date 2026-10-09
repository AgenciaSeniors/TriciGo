import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
const mockInvoke = vi.fn();
const mockSingle = vi.fn();
const mockSelect = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockGetUser = vi.fn();

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({
    rpc: mockRpc,
    functions: { invoke: mockInvoke },
    from: () => ({ insert: mockInsert }),
    auth: { getUser: mockGetUser },
  }),
}));

import { campaignService } from '../campaign.service';
import { AppError } from '../../errors';

const INPUT = {
  name: 'Lluvia', audienceRole: 'customer' as const, segmentType: 'all' as const, segmentCityId: null,
  title: 'Llueve', body: 'Pide tu triciclo', promoCodeId: null, channel: 'push' as const,
  scheduledAt: '2026-10-10T14:00:00.000Z',
};

describe('campaignService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockInvoke.mockReset();
    mockSingle.mockReset();
    mockInsert.mockClear();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u-1' } } });
  });

  it('create inserts the row without status or counters and returns its id', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: 'c-1' }, error: null });
    await expect(campaignService.create(INPUT)).resolves.toBe('c-1');
    expect(mockInsert).toHaveBeenCalledWith({
      name: 'Lluvia', audience_role: 'customer', segment_type: 'all', segment_city_id: null,
      message_title: 'Llueve', message_body: 'Pide tu triciclo', promo_code_id: null, channel: 'push',
      scheduled_at: '2026-10-10T14:00:00.000Z', created_by: 'u-1',
    });
  });

  it('create throws the database error', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
    await expect(campaignService.create(INPUT)).rejects.toMatchObject({ message: 'denied' });
  });

  it('sendNow calls send-campaign with the id and returns its result', async () => {
    const result = { id: 'c-1', status: 'sent', recipient_count: 3, push_sent: 3, email_sent: 0, sent_count: 3,
      last_error: null, channels: [{ channel: 'push', ok: true, sent: 3 }] };
    mockInvoke.mockResolvedValueOnce({ data: result, error: null });
    await expect(campaignService.sendNow('c-1')).resolves.toEqual(result);
    expect(mockInvoke).toHaveBeenCalledWith('send-campaign', { body: { campaign_id: 'c-1' } });
  });

  it('sendNow turns a 409 into CAMPAIGN_NOT_CLAIMABLE with the current status', async () => {
    const context = new Response(JSON.stringify({ error: 'not_claimable', status: 'sending' }), { status: 409 });
    mockInvoke.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('409'), { context }) });
    const err = await campaignService.sendNow('c-1').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'CAMPAIGN_NOT_CLAIMABLE', statusCode: 409, details: { status: 'sending' } });
  });

  it('sendNow throws any other error as is', async () => {
    const e = new Error('Failed to fetch');
    mockInvoke.mockResolvedValueOnce({ data: null, error: e });
    await expect(campaignService.sendNow('c-1')).rejects.toBe(e);
  });

  it('cancel returns what the RPC returns', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'cancelled', error: null });
    await expect(campaignService.cancel('c-1')).resolves.toBe('cancelled');
    expect(mockRpc).toHaveBeenCalledWith('cancel_campaign', { p_campaign_id: 'c-1' });
    mockRpc.mockResolvedValueOnce({ data: 'sending', error: null });
    await expect(campaignService.cancel('c-1')).resolves.toBe('sending');
  });

  it('cancel turns the forbidden error into CAMPAIGN_CANCEL_FORBIDDEN with the server message', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'Solo puedes cancelar las campañas que creaste.', details: 'campaign_cancel_forbidden' },
    });
    const err = await campaignService.cancel('c-1').catch((e) => e);
    expect(err).toMatchObject({ code: 'CAMPAIGN_CANCEL_FORBIDDEN', statusCode: 400,
      message: 'Solo puedes cancelar las campañas que creaste.' });
  });
});
