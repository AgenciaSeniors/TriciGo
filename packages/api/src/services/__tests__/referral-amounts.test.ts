import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSupabase = { rpc: mockRpc, from: mockFrom };
vi.mock('../../client', () => ({ getSupabaseClient: () => mockSupabase }));

import { referralService, REFERRAL_AMOUNT_KEYS } from '../referral.service';
import { AppError } from '../../errors';

function selectChain(rows: { key: string; value: unknown }[] | null, error: unknown = null) {
  const chain = { select: vi.fn(), in: vi.fn() };
  chain.select.mockReturnValue(chain);
  chain.in.mockResolvedValue({ data: rows, error });
  return chain;
}

describe('referralService.getReferralAmounts', () => {
  beforeEach(() => { mockRpc.mockReset(); mockFrom.mockReset(); });

  it('reads the four keys and defaults a missing one to 0', async () => {
    const chain = selectChain([
      { key: 'referral_bonus_cup', value: 500 },
      { key: 'referral_bonus_driver_cup', value: 1000 },
      { key: 'referral_welcome_bonus_cup', value: '0' },
    ]);
    mockFrom.mockReturnValue(chain);
    const amounts = await referralService.getReferralAmounts();
    expect(mockFrom).toHaveBeenCalledWith('platform_config');
    expect(chain.select).toHaveBeenCalledWith('key, value');
    expect(chain.in).toHaveBeenCalledWith('key', [...REFERRAL_AMOUNT_KEYS]);
    expect(amounts).toEqual({
      referral_bonus_cup: 500,
      referral_bonus_driver_cup: 1000,
      referral_welcome_bonus_cup: 0,
      referral_welcome_bonus_driver_cup: 0,
    });
  });

  it('reads a value stored as a JSON string and turns a non-number into 0', async () => {
    mockFrom.mockReturnValue(selectChain([
      { key: 'referral_bonus_cup', value: '750' },
      { key: 'referral_bonus_driver_cup', value: 'abc' },
      { key: 'some_other_key', value: 99 },
    ]));
    const amounts = await referralService.getReferralAmounts();
    expect(amounts).toEqual({
      referral_bonus_cup: 750,
      referral_bonus_driver_cup: 0,
      referral_welcome_bonus_cup: 0,
      referral_welcome_bonus_driver_cup: 0,
    });
  });

  it('throws the query error', async () => {
    mockFrom.mockReturnValue(selectChain(null, { message: 'boom' }));
    await expect(referralService.getReferralAmounts()).rejects.toEqual({ message: 'boom' });
  });
});

describe('referralService.setReferralAmounts', () => {
  beforeEach(() => { mockRpc.mockReset(); mockFrom.mockReset(); });

  it('sends only the given keys and returns the saved amounts', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, amounts: { referral_bonus_cup: 700, referral_bonus_driver_cup: 1000, referral_welcome_bonus_cup: 0, referral_welcome_bonus_driver_cup: 300 } },
      error: null,
    });
    const saved = await referralService.setReferralAmounts({ referral_bonus_cup: 700, referral_welcome_bonus_driver_cup: 300 });
    expect(mockRpc).toHaveBeenCalledWith('set_referral_amounts', { p_amounts: { referral_bonus_cup: 700, referral_welcome_bonus_driver_cup: 300 } });
    expect(saved).toEqual({
      referral_bonus_cup: 700,
      referral_bonus_driver_cup: 1000,
      referral_welcome_bonus_cup: 0,
      referral_welcome_bonus_driver_cup: 300,
    });
  });

  it.each([
    ['forbidden', 'No tienes permiso para cambiar los montos de referidos.'],
    ['invalid_amount', 'Los montos tienen que ser números enteros, 0 o más.'],
    ['unknown_key', 'Uno de los montos no existe. Recarga la página.'],
    ['nothing_to_save', 'No hay cambios para guardar.'],
  ])('maps %s to a Spanish message', async (code, message) => {
    mockRpc.mockResolvedValue({ data: { error: code }, error: null });
    await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toThrow(message);
  });

  it('throws an AppError with status 400 and a code, so the panel shows the message as is', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'invalid_amount', key: 'referral_bonus_cup' }, error: null });
    const err = await referralService.setReferralAmounts({ referral_bonus_cup: -1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'REFERRAL_AMOUNTS_INVALID_AMOUNT',
      statusCode: 400,
      details: { key: 'referral_bonus_cup' },
    });
  });

  it('falls back to a generic message for an unknown refusal or no success flag', async () => {
    mockRpc.mockResolvedValue({ data: { error: 'something_new' }, error: null });
    await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toThrow('No se pudieron guardar los montos.');
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toThrow('No se pudieron guardar los montos.');
  });

  it('says the feature is not available yet when the RPC is missing', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toThrow('Esta función todavía no está disponible.');
  });

  it('rethrows any other database error as it came', async () => {
    const dbError = { code: '42501', message: 'permission denied for function set_referral_amounts' };
    mockRpc.mockResolvedValue({ data: null, error: dbError });
    await expect(referralService.setReferralAmounts({ referral_bonus_cup: 1 })).rejects.toEqual(dbError);
  });
});
