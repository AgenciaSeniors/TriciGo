import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A query chain that records every call and resolves to the next queued result. */
const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
const results: Array<{ data: unknown; error: unknown }> = [];
function chain(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const result = results.shift() ?? { data: [], error: null };
  const proxy: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'gte', 'lt', 'lte', 'or', 'ilike', 'order', 'range', 'limit', 'maybeSingle', 'single']) {
    proxy[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return proxy;
    };
  }
  proxy.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return proxy;
}
const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from: (t: string) => chain(t), rpc: mockRpc }),
}));

import { panelReadService } from '../panel-read.service';

beforeEach(() => {
  calls.length = 0;
  results.length = 0;
  mockRpc.mockReset();
});

describe('panelReadService.getRides', () => {
  it('reads panel_rides with the same filters as the admin list', async () => {
    results.push({ data: [{ id: 'r1' }], error: null });
    const rows = await panelReadService.getRides({ status: 'canceled', search: 'F1A2B3C4', rideMode: 'cargo' }, 1, 20);
    expect(rows).toEqual([{ id: 'r1' }]);
    expect(calls[0]!.table).toBe('panel_rides');
    expect(calls[0]!.ops).toEqual(expect.arrayContaining([
      ['select', ['*']],
      ['range', [20, 39]],
      ['eq', ['status', 'canceled']],
      ['eq', ['ride_mode', 'cargo']],
      ['gte', ['id', 'f1a2b3c4-0000-0000-0000-000000000000']],
      ['lte', ['id', 'f1a2b3c4-ffff-ffff-ffff-ffffffffffff']],
    ]));
  });

  it('searches addresses when the text is not a ride code, escaping LIKE characters', async () => {
    results.push({ data: [], error: null });
    await panelReadService.getRides({ search: 'Calle 23_%' });
    expect(calls[0]!.ops).toContainEqual(['or', ['pickup_address.ilike.%Calle 23\\_\\%%,dropoff_address.ilike.%Calle 23\\_\\%%']]);
  });

  it('throws the Supabase error', async () => {
    results.push({ data: null, error: new Error('boom') });
    await expect(panelReadService.getRides()).rejects.toThrow('boom');
  });
});

describe('panelReadService.getDrivers', () => {
  it('reads panel_driver_profiles and shapes rows like the admin list', async () => {
    results.push({
      data: [{ id: 'd1', full_name: 'Diego', phone: null, email: 'd@x.cu', vehicle_type: 'triciclo', plate_number: 'P1' },
             { id: 'd2', full_name: 'Sin auto', phone: '+535', email: null, vehicle_type: null, plate_number: null }],
      error: null,
    });
    const rows = await panelReadService.getDrivers(0, 20, { search: 'Die', vehicleType: 'triciclo', ratingMin: 4 });
    expect(calls[0]!.table).toBe('panel_driver_profiles');
    expect(calls[0]!.ops).toEqual(expect.arrayContaining([
      ['ilike', ['full_name', '%Die%']],
      ['eq', ['vehicle_type', 'triciclo']],
      ['gte', ['rating_avg', 4]],
    ]));
    expect(rows[0]!.users).toEqual({ full_name: 'Diego', phone: '', email: 'd@x.cu' });
    expect(rows[0]!.vehicles).toEqual([{ type: 'triciclo', plate_number: 'P1' }]);
    expect(rows[1]!.vehicles).toEqual([]);
  });
});
