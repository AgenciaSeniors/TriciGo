import { describe, it, expect, vi, beforeEach, assert } from 'vitest';

// Mock the Supabase client (rpc + auth.getUser for admin methods)
const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockGetUser = vi.fn();
const mockSupabase = { from: mockFrom, rpc: mockRpc, auth: { getUser: mockGetUser } };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

// Import after mock is set up
import { walletService } from '../wallet.service';
import { adminService } from '../admin.service';

const FROM = '11111111-1111-1111-1111-111111111111';
const TO = '22222222-2222-2222-2222-222222222222';

describe('walletService gifts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==================== sendGift ====================
  describe('sendGift', () => {
    it('calls send_gift RPC with mapped params and returns the transfer id', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'gift-tx-1', error: null });

      const result = await walletService.sendGift(FROM, TO, 500, '¡Feliz cumple!');

      expect(mockRpc).toHaveBeenCalledWith('send_gift', {
        p_from_user_id: FROM,
        p_to_user_id: TO,
        p_amount: 500,
        p_note: '¡Feliz cumple!',
      });
      expect(result).toBe('gift-tx-1');
    });

    it('passes null note when omitted', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'gift-tx-2', error: null });
      await walletService.sendGift(FROM, TO, 100);
      expect(mockRpc).toHaveBeenCalledWith('send_gift', expect.objectContaining({ p_note: null }));
    });

    it('forwards p_from_wallet when the caller specifies the source wallet', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'gift-tx-w', error: null });
      await walletService.sendGift(FROM, TO, 500, undefined, 'tricicoin');
      expect(mockRpc).toHaveBeenCalledWith('send_gift', expect.objectContaining({ p_from_wallet: 'tricicoin' }));
    });

    it('omits p_from_wallet when the caller does not specify it', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'gift-tx-x', error: null });
      await walletService.sendGift(FROM, TO, 100);
      const call = mockRpc.mock.calls[0];
      assert(call);
      expect(call[1]).not.toHaveProperty('p_from_wallet');
    });

    it('rejects self-gift before hitting the RPC (Zod refine)', async () => {
      await expect(walletService.sendGift(FROM, FROM, 100)).rejects.toThrow();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects non-positive amount before hitting the RPC', async () => {
      await expect(walletService.sendGift(FROM, TO, 0)).rejects.toThrow();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('propagates the RPC error (e.g. insufficient balance)', async () => {
      const err = { message: 'Insufficient balance. Available: 10, Required: 500', code: 'P0001' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(walletService.sendGift(FROM, TO, 500)).rejects.toEqual(err);
    });
  });

  // ==================== findUserByPhone ====================
  describe('findUserByPhone', () => {
    it('returns the first matching active user', async () => {
      const row = { id: TO, full_name: 'Lucía', phone: '+5355512345' };
      mockRpc.mockResolvedValueOnce({ data: [row], error: null });

      const result = await walletService.findUserByPhone('+5355512345');

      expect(mockRpc).toHaveBeenCalledWith('find_user_by_phone', { p_phone: '+5355512345' });
      expect(result).toEqual(row);
    });

    it('returns null when no user matches', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      const result = await walletService.findUserByPhone('+5355500000');
      expect(result).toBeNull();
    });

    it('rejects an invalid Cuban phone before hitting the RPC', async () => {
      await expect(walletService.findUserByPhone('12345')).rejects.toThrow();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('normalizes a bare local number (5XXXXXXX) to canonical before the RPC', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await walletService.findUserByPhone('55512345');
      expect(mockRpc).toHaveBeenCalledWith('find_user_by_phone', { p_phone: '+5355512345' });
    });

    it('normalizes a country-code-without-plus number (535XXXXXXX) before the RPC', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await walletService.findUserByPhone('5355512345');
      expect(mockRpc).toHaveBeenCalledWith('find_user_by_phone', { p_phone: '+5355512345' });
    });

    it('trims surrounding whitespace before normalizing', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      await walletService.findUserByPhone('  +5355512345  ');
      expect(mockRpc).toHaveBeenCalledWith('find_user_by_phone', { p_phone: '+5355512345' });
    });
  });

  // ==================== findUserByGiftCode ====================
  describe('findUserByGiftCode', () => {
    it('returns the first matching user by code', async () => {
      const row = { id: TO, full_name: 'Lucía' };
      mockRpc.mockResolvedValueOnce({ data: [row], error: null });

      const result = await walletService.findUserByGiftCode('ABCD12');

      expect(mockRpc).toHaveBeenCalledWith('find_user_by_gift_code', { p_code: 'ABCD12' });
      expect(result).toEqual(row);
    });

    it('returns null when the code resolves to nothing', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      const result = await walletService.findUserByGiftCode('ZZZZZZ');
      expect(result).toBeNull();
    });

    it('rejects a malformed code before hitting the RPC', async () => {
      await expect(walletService.findUserByGiftCode('no spaces!')).rejects.toThrow();
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});

describe('adminService gifts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } } });
  });

  describe('sendGift', () => {
    it('calls admin_send_gift with the authenticated admin id', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'gift-tx-3', error: null });

      const result = await adminService.sendGift(TO, 1000, 'Promo bienvenida');

      expect(mockRpc).toHaveBeenCalledWith('admin_send_gift', {
        p_to_user_id: TO,
        p_amount: 1000,
        p_note: 'Promo bienvenida',
        p_admin_user_id: 'admin-1',
      });
      expect(result).toBe('gift-tx-3');
    });

    it('throws when no admin is authenticated', async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: null } });
      await expect(adminService.sendGift(TO, 1000, 'x')).rejects.toThrow('Admin not authenticated');
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe('reverseGift', () => {
    it('calls admin_reverse_gift with the transfer id and admin id', async () => {
      mockRpc.mockResolvedValueOnce({ data: 'reversal-tx-1', error: null });

      const result = await adminService.reverseGift('gift-tx-1');

      expect(mockRpc).toHaveBeenCalledWith('admin_reverse_gift', {
        p_transfer_id: 'gift-tx-1',
        p_admin_user_id: 'admin-1',
      });
      expect(result).toBe('reversal-tx-1');
    });

    it('propagates the RPC error (already reversed)', async () => {
      const err = { message: 'Gift already reversed', code: 'P0001' };
      mockRpc.mockResolvedValueOnce({ data: null, error: err });
      await expect(adminService.reverseGift('gift-tx-1')).rejects.toEqual(err);
    });
  });

  describe('getGiftStats', () => {
    it('maps the RPC jsonb to numbers', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { total_gifts: 12, reversed: 1, volume_cup: 5400, gifts_7d: 3, distinct_senders: 4 },
        error: null,
      });
      const result = await adminService.getGiftStats();
      expect(mockRpc).toHaveBeenCalledWith('get_gift_stats');
      expect(result).toEqual({ total_gifts: 12, reversed: 1, volume_cup: 5400, gifts_7d: 3, distinct_senders: 4 });
    });

    it('defaults to zeros when fields are missing', async () => {
      mockRpc.mockResolvedValueOnce({ data: {}, error: null });
      const result = await adminService.getGiftStats();
      expect(result).toEqual({ total_gifts: 0, reversed: 0, volume_cup: 0, gifts_7d: 0, distinct_senders: 0 });
    });
  });

  describe('freezeWallet', () => {
    it('calls freeze_wallet with the authenticated admin id', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await adminService.freezeWallet(TO, 'Abuso detectado');
      expect(mockRpc).toHaveBeenCalledWith('freeze_wallet', {
        p_user_id: TO,
        p_reason: 'Abuso detectado',
        p_admin_id: 'admin-1',
      });
    });

    it('throws when no admin is authenticated', async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: null } });
      await expect(adminService.freezeWallet(TO, 'x')).rejects.toThrow('Admin not authenticated');
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe('unfreezeWallet', () => {
    it('calls unfreeze_wallet with the admin id', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });
      await adminService.unfreezeWallet(TO);
      expect(mockRpc).toHaveBeenCalledWith('unfreeze_wallet', { p_user_id: TO, p_admin_id: 'admin-1' });
    });
  });
});
