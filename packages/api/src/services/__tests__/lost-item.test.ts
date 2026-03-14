import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client
const mockSingle = vi.fn();
const mockMaybeSingle = vi.fn();
const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockEq = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })), eq: mockEq, order: mockOrder }));
const mockOr = vi.fn(() => ({ order: mockOrder }));
const mockSelect = vi.fn(() => ({ eq: mockEq, or: mockOr, order: mockOrder }));
const mockInsert = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) }));
const mockUpdate = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({
  select: mockSelect,
  insert: mockInsert,
  update: mockUpdate,
}));
const mockSupabase = { from: mockFrom };

vi.mock('../../client', () => ({
  getSupabaseClient: () => mockSupabase,
}));

import { lostItemService } from '../lost-item.service';

const MOCK_LOST_ITEM = {
  id: 'li-1',
  ride_id: 'r-1',
  reporter_id: 'user-1',
  driver_id: 'driver-1',
  description: 'Black wallet with cards',
  category: 'wallet',
  photo_urls: [],
  status: 'reported',
  driver_response: null,
  driver_found: null,
  return_fee_cup: null,
  return_location: null,
  return_notes: null,
  admin_notes: null,
  resolved_by: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  resolved_at: null,
};

describe('lostItemService.reportLostItem', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('inserts a lost item report', async () => {
    mockSingle.mockResolvedValue({ data: MOCK_LOST_ITEM, error: null });
    const result = await lostItemService.reportLostItem({
      ride_id: 'r-1',
      reporter_id: 'user-1',
      driver_id: 'driver-1',
      description: 'Black wallet with cards',
      category: 'wallet',
    });
    expect(mockFrom).toHaveBeenCalledWith('lost_items');
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ride_id: 'r-1',
        reporter_id: 'user-1',
        driver_id: 'driver-1',
        description: 'Black wallet with cards',
        category: 'wallet',
        photo_urls: [],
      }),
    );
    expect(result).toEqual(MOCK_LOST_ITEM);
  });

  it('throws on insert error', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'Duplicate' } });
    await expect(
      lostItemService.reportLostItem({
        ride_id: 'r-1',
        reporter_id: 'user-1',
        driver_id: 'driver-1',
        description: 'Phone',
        category: 'phone',
      }),
    ).rejects.toEqual({ message: 'Duplicate' });
  });
});

describe('lostItemService.getLostItemByRide', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns lost item for ride', async () => {
    mockMaybeSingle.mockResolvedValue({ data: MOCK_LOST_ITEM, error: null });
    const result = await lostItemService.getLostItemByRide('r-1');
    expect(mockFrom).toHaveBeenCalledWith('lost_items');
    expect(result).toEqual(MOCK_LOST_ITEM);
  });

  it('returns null when no lost item exists', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await lostItemService.getLostItemByRide('r-nonexistent');
    expect(result).toBeNull();
  });
});

describe('lostItemService.getMyLostItems', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches lost items for user as reporter or driver', async () => {
    mockOrder.mockReturnValueOnce({ data: [MOCK_LOST_ITEM], error: null });
    const result = await lostItemService.getMyLostItems('user-1');
    expect(mockFrom).toHaveBeenCalledWith('lost_items');
    expect(mockOr).toHaveBeenCalledWith('reporter_id.eq.user-1,driver_id.eq.user-1');
    expect(result).toEqual([MOCK_LOST_ITEM]);
  });
});

describe('lostItemService.driverRespond', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates item with found status', async () => {
    const foundItem = { ...MOCK_LOST_ITEM, driver_found: true, status: 'found' };
    mockSingle.mockResolvedValue({ data: foundItem, error: null });
    const result = await lostItemService.driverRespond('li-1', 'driver-1', true, 'Found under seat');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        driver_found: true,
        status: 'found',
        driver_response: 'Found under seat',
      }),
    );
    expect(result).toEqual(foundItem);
  });

  it('updates item with not found status', async () => {
    const notFoundItem = { ...MOCK_LOST_ITEM, driver_found: false, status: 'not_found' };
    mockSingle.mockResolvedValue({ data: notFoundItem, error: null });
    const result = await lostItemService.driverRespond('li-1', 'driver-1', false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        driver_found: false,
        status: 'not_found',
      }),
    );
    expect(result).toEqual(notFoundItem);
  });
});

describe('lostItemService.arrangeReturn', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets return details and status', async () => {
    const arranged = { ...MOCK_LOST_ITEM, status: 'return_arranged', return_fee_cup: 200, return_location: 'Parque Central' };
    mockSingle.mockResolvedValue({ data: arranged, error: null });
    const result = await lostItemService.arrangeReturn('li-1', {
      return_fee_cup: 200,
      return_location: 'Parque Central',
      return_notes: 'Tomorrow at 3pm',
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'return_arranged',
        return_fee_cup: 200,
        return_location: 'Parque Central',
        return_notes: 'Tomorrow at 3pm',
      }),
    );
    expect(result).toEqual(arranged);
  });
});

describe('lostItemService.markReturned', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('marks item as returned with resolver', async () => {
    const returned = { ...MOCK_LOST_ITEM, status: 'returned', resolved_by: 'driver-1' };
    mockSingle.mockResolvedValue({ data: returned, error: null });
    const result = await lostItemService.markReturned('li-1', 'driver-1');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'returned',
        resolved_by: 'driver-1',
      }),
    );
    expect(result).toEqual(returned);
  });
});

describe('lostItemService.closeLostItem', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('closes item with admin notes', async () => {
    const closed = { ...MOCK_LOST_ITEM, status: 'closed', resolved_by: 'admin-1', admin_notes: 'Abandoned' };
    mockSingle.mockResolvedValue({ data: closed, error: null });
    const result = await lostItemService.closeLostItem('li-1', 'admin-1', 'Abandoned');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'closed',
        resolved_by: 'admin-1',
        admin_notes: 'Abandoned',
      }),
    );
    expect(result).toEqual(closed);
  });
});

describe('lostItemService.getAllLostItems', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches all lost items with default limit', async () => {
    const mockLimitResult = vi.fn().mockReturnValue({ data: [MOCK_LOST_ITEM], error: null });
    const mockOrderResult = vi.fn().mockReturnValue({ limit: mockLimitResult });
    mockSelect.mockReturnValueOnce({ eq: mockEq, or: mockOr, order: mockOrderResult });
    const result = await lostItemService.getAllLostItems();
    expect(mockFrom).toHaveBeenCalledWith('lost_items');
    expect(result).toEqual([MOCK_LOST_ITEM]);
  });

  it('filters by status when provided', async () => {
    const mockLimitResult = vi.fn().mockReturnValue({ data: [MOCK_LOST_ITEM], error: null });
    const mockOrderResult = vi.fn().mockReturnValue({ limit: mockLimitResult });
    const mockEqStatus = vi.fn().mockReturnValue({ order: mockOrderResult });
    mockSelect.mockReturnValueOnce({ eq: mockEqStatus, or: mockOr, order: mockOrderResult });
    const result = await lostItemService.getAllLostItems({ status: 'reported' });
    expect(mockFrom).toHaveBeenCalledWith('lost_items');
    expect(result).toEqual([MOCK_LOST_ITEM]);
  });
});

describe('lostItemService.addAdminNotes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates admin notes', async () => {
    mockEq.mockReturnValueOnce({ error: null });
    await lostItemService.addAdminNotes('li-1', 'Contacted driver');
    expect(mockFrom).toHaveBeenCalledWith('lost_items');
    expect(mockUpdate).toHaveBeenCalledWith({ admin_notes: 'Contacted driver' });
  });
});
