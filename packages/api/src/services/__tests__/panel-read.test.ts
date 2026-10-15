import { beforeEach, describe, expect, it, vi } from 'vitest';
import { havanaDayRangeUtc } from '@tricigo/utils';

/** What postgrest-js answers when single() or maybeSingle() cannot pick one row. */
const PGRST116 = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };

/**
 * A query chain that records every call and resolves to the next queued result (an unqueued call
 * finds no rows). Like supabase-js, single() and maybeSingle() turn a list of rows into one row:
 * maybeSingle() gives null for no rows, single() an error; both give an error for 2+ rows.
 */
const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
const results: Array<{ data: unknown; error: unknown }> = [];
function chain(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const queued = results.shift() ?? { data: [], error: null };
  const proxy: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'gte', 'lt', 'lte', 'or', 'ilike', 'order', 'range', 'limit', 'maybeSingle', 'single']) {
    proxy[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return proxy;
    };
  }
  const settle = () => {
    const mode = entry.ops.some(([op]) => op === 'single') ? 'single'
      : entry.ops.some(([op]) => op === 'maybeSingle') ? 'maybeSingle' : null;
    if (!mode || queued.error || !Array.isArray(queued.data)) return queued;
    const rows = queued.data;
    if (rows.length === 1) return { data: rows[0], error: null };
    if (rows.length === 0 && mode === 'maybeSingle') return { data: null, error: null };
    return { data: null, error: PGRST116 };
  };
  proxy.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(settle()).then(resolve, reject);
  return proxy;
}
/** The error PostgREST gives for an id that is not a uuid. */
const BAD_UUID = { code: '22P02', message: 'invalid input syntax for type uuid: "abc"' };
const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from: (t: string) => chain(t), rpc: mockRpc }),
}));

import { panelReadService, parseProductFailures } from '../panel-read.service';

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

  it('finds a ride code by its id range alone, with no address filter', async () => {
    await panelReadService.getRides({ search: ' #F1A2B3C4 ' });
    expect(calls[0]!.ops).toContainEqual(['gte', ['id', 'f1a2b3c4-0000-0000-0000-000000000000']]);
    expect(calls[0]!.ops.some(([op]) => op === 'or')).toBe(false);
  });

  it('reads the date inputs as Havana calendar days', async () => {
    await panelReadService.getRides({ dateFrom: '2026-07-10', dateTo: '2026-07-12' });
    const from = havanaDayRangeUtc('2026-07-10').start.toISOString();
    const to = havanaDayRangeUtc('2026-07-12').end.toISOString();
    // July is Cuban summer time (UTC-4): a day starts at 04:00 UTC.
    expect([from, to]).toEqual(['2026-07-10T04:00:00.000Z', '2026-07-13T04:00:00.000Z']);
    expect(calls[0]!.ops).toContainEqual(['gte', ['created_at', from]]);
    expect(calls[0]!.ops).toContainEqual(['lt', ['created_at', to]]);
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

  it('does not filter by status for "all"', async () => {
    await panelReadService.getDrivers(0, 20, { status: 'all' });
    await panelReadService.getDrivers(0, 20, { status: 'approved' });
    expect(calls[0]!.ops.some(([op, args]) => op === 'eq' && args[0] === 'status')).toBe(false);
    expect(calls[1]!.ops).toContainEqual(['eq', ['status', 'approved']]);
  });
});

describe('panelReadService details', () => {
  it('reads a ride, its timeline, its price and both people without the chat or delivery', async () => {
    results.push(
      { data: { id: 'r1', customer_id: 'c1', driver_id: 'd1' }, error: null }, // panel_rides
      { data: [{ id: 't1' }], error: null },                                   // ride_transitions
      { data: { ride_id: 'r1', total: 1500 }, error: null },                    // ride_pricing_snapshots
      { data: { full_name: 'Carla', phone: '+5355' }, error: null },            // users
      { data: { id: 'd1', full_name: 'Diego', phone: null }, error: null },     // panel_driver_profiles
    );
    const detail = await panelReadService.getRideDetail('r1');
    expect(calls.map((c) => c.table)).toEqual(['panel_rides', 'ride_transitions', 'ride_pricing_snapshots', 'users', 'panel_driver_profiles']);
    expect(calls[0]!.ops).toContainEqual(['maybeSingle', []]);
    expect(detail?.customerInfo).toEqual({ name: 'Carla', phone: '+5355' });
    expect(detail?.driverInfo).toEqual({ id: 'd1', name: 'Diego', phone: null });
    expect(detail?.pricing).toEqual({ ride_id: 'r1', total: 1500 });
    expect(detail?.pricingUnavailable).toBe(false);
  });

  it('answers null for a ride that does not exist or an id that is not a uuid', async () => {
    expect(await panelReadService.getRideDetail('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['panel_rides', 'ride_transitions', 'ride_pricing_snapshots']);
    calls.length = 0;
    results.push({ data: null, error: BAD_UUID }, { data: null, error: BAD_UUID }, { data: null, error: BAD_UUID });
    expect(await panelReadService.getRideDetail('abc')).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['panel_rides', 'ride_transitions', 'ride_pricing_snapshots']);
  });

  it('throws when the ride or its timeline cannot be read', async () => {
    results.push({ data: null, error: new Error('ride read failed') });
    await expect(panelReadService.getRideDetail('r1')).rejects.toThrow('ride read failed');
    results.length = 0;
    results.push(
      { data: { id: 'r1', customer_id: 'c1', driver_id: null }, error: null },
      { data: null, error: new Error('timeline read failed') },
    );
    await expect(panelReadService.getRideDetail('r1')).rejects.toThrow('timeline read failed');
  });

  it('marks the price unavailable when its read fails, instead of looking like no snapshot', async () => {
    results.push(
      { data: { id: 'r1', customer_id: 'c1', driver_id: null }, error: null },
      { data: [], error: null },
      { data: null, error: new Error('pricing read failed') },
    );
    const detail = await panelReadService.getRideDetail('r1');
    expect(detail?.pricing).toBeNull();
    expect(detail?.pricingUnavailable).toBe(true);
  });

  it('does not look for a driver when the ride has none', async () => {
    results.push(
      { data: { id: 'r1', customer_id: 'c1', driver_id: null }, error: null },
      { data: [], error: null },
      { data: null, error: null },
      { data: { full_name: 'Carla', phone: null }, error: null },
    );
    const detail = await panelReadService.getRideDetail('r1');
    expect(calls.map((c) => c.table)).toEqual(['panel_rides', 'ride_transitions', 'ride_pricing_snapshots', 'users']);
    expect(detail?.driverInfo).toBeNull();
    expect(detail?.pricing).toBeNull();
    expect(detail?.pricingUnavailable).toBe(false);
    expect(detail?.transitions).toEqual([]);
  });

  it('reads a driver from the views and keeps the latest document per type', async () => {
    results.push(
      { data: { id: 'd1', user_id: 'u-d1', full_name: 'Diego' }, error: null }, // panel_driver_profiles
      { data: [
          { id: 'a', document_type: 'selfie', uploaded_at: '2026-10-02' },
          { id: 'b', document_type: 'selfie', uploaded_at: '2026-10-01' },
          { id: 'c', document_type: 'national_id', uploaded_at: '2026-10-01' },
        ], error: null },                                                     // panel_driver_documents
      { data: [{ id: 'e1' }], error: null },                                  // driver_score_events
      { data: { driver_profile_id: 'd1', risk_level: 'high' }, error: null }, // panel_driver_churn_risk
    );
    const detail = await panelReadService.getDriverDetail('d1');
    expect(calls.map((c) => c.table)).toEqual(['panel_driver_profiles', 'panel_driver_documents', 'driver_score_events', 'panel_driver_churn_risk']);
    expect(detail?.documents.map((d) => d.id)).toEqual(['a', 'c']);
    expect(detail?.churn).toEqual({ driver_profile_id: 'd1', risk_level: 'high' });
    expect(detail?.churnUnavailable).toBe(false);
  });

  it('filters documents and churn by the profile id, and score events by the user id', async () => {
    // driver_documents.driver_id and driver_churn_risk.driver_profile_id are the profile id;
    // driver_score_events.driver_id references users(id) (all 12 rows in prod match a user_id and none a profile id).
    results.push({ data: { id: 'd1', user_id: 'u-d1' }, error: null });
    await panelReadService.getDriverDetail('d1');
    const byTable = Object.fromEntries(calls.map((c) => [c.table, c.ops]));
    expect(byTable['panel_driver_profiles']).toContainEqual(['eq', ['id', 'd1']]);
    expect(byTable['panel_driver_documents']).toContainEqual(['eq', ['driver_id', 'd1']]);
    expect(byTable['driver_score_events']).toContainEqual(['eq', ['driver_id', 'u-d1']]);
    expect(byTable['panel_driver_churn_risk']).toContainEqual(['eq', ['driver_profile_id', 'd1']]);
  });

  it('answers null and reads nothing else for a driver that does not exist or an id that is not a uuid', async () => {
    expect(await panelReadService.getDriverDetail('00000000-0000-0000-0000-000000000000')).toBeNull();
    results.push({ data: null, error: BAD_UUID });
    expect(await panelReadService.getDriverDetail('abc')).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['panel_driver_profiles', 'panel_driver_profiles']);
  });

  it('throws when the profile cannot be read, and reads nothing else', async () => {
    results.push({ data: null, error: new Error('profile read failed') });
    await expect(panelReadService.getDriverDetail('d1')).rejects.toThrow('profile read failed');
    expect(calls.map((c) => c.table)).toEqual(['panel_driver_profiles']);
  });

  it('throws when the documents or the score events cannot be read', async () => {
    results.push({ data: { id: 'd1', user_id: 'u-d1' }, error: null }, { data: null, error: new Error('documents read failed') });
    await expect(panelReadService.getDriverDetail('d1')).rejects.toThrow('documents read failed');
    results.length = 0;
    results.push(
      { data: { id: 'd1', user_id: 'u-d1' }, error: null },
      { data: [], error: null },
      { data: null, error: new Error('score events read failed') },
    );
    await expect(panelReadService.getDriverDetail('d1')).rejects.toThrow('score events read failed');
  });

  it('marks churn risk unavailable when its read fails, instead of looking like no risk row', async () => {
    results.push(
      { data: { id: 'd1', user_id: 'u-d1' }, error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: new Error('churn read failed') },
    );
    const detail = await panelReadService.getDriverDetail('d1');
    expect(detail?.churn).toBeNull();
    expect(detail?.churnUnavailable).toBe(true);
  });

  it('counts a user’s rides and total spent from panel_rides', async () => {
    results.push(
      { data: { id: 'u1', full_name: 'Carla' }, error: null },
      { data: [
          { status: 'completed', final_fare_cup: 1500 },
          { status: 'completed', final_fare_cup: null },
          { status: 'canceled', final_fare_cup: null },
          { status: 'searching', final_fare_cup: null },
        ], error: null },
    );
    const detail = await panelReadService.getUserDetail('u1');
    expect(calls.map((c) => c.table)).toEqual(['users', 'panel_rides']);
    expect(detail).toMatchObject({ ridesAsCustomer: 4, completedAsCustomer: 2, canceledAsCustomer: 1, totalSpentCup: 1500 });
  });

  it('answers null for a user that does not exist or an id that is not a uuid', async () => {
    expect(await panelReadService.getUserDetail('00000000-0000-0000-0000-000000000000')).toBeNull();
    results.push({ data: null, error: BAD_UUID }, { data: null, error: BAD_UUID });
    expect(await panelReadService.getUserDetail('abc')).toBeNull();
  });

  it('throws when the user or their rides cannot be read, instead of showing 0 rides', async () => {
    results.push({ data: null, error: new Error('user read failed') });
    await expect(panelReadService.getUserDetail('u1')).rejects.toThrow('user read failed');
    results.length = 0;
    results.push({ data: { id: 'u1', full_name: 'Carla' }, error: null }, { data: null, error: new Error('rides read failed') });
    await expect(panelReadService.getUserDetail('u1')).rejects.toThrow('rides read failed');
  });

  it('reads disputes and incidents from their views', async () => {
    results.push({ data: [{ id: 'x' }], error: null }, { data: [{ id: 'y' }], error: null });
    await panelReadService.getDisputes({ status: 'open', limit: 10 });
    await panelReadService.getIncidents('open', 0, 20);
    expect(calls.map((c) => c.table)).toEqual(['panel_ride_disputes', 'panel_incident_reports']);
    expect(calls[0]!.ops).toContainEqual(['eq', ['status', 'open']]);
    expect(calls[0]!.ops).toContainEqual(['limit', [10]]);
  });

  it('does not filter by status for "all" and pages incidents', async () => {
    await panelReadService.getIncidents('all', 2, 20);
    await panelReadService.getDisputes();
    expect(calls[0]!.ops).toContainEqual(['range', [40, 59]]);
    expect(calls[0]!.ops.some(([op]) => op === 'eq')).toBe(false);
    expect(calls[1]!.ops.some(([op]) => op === 'eq')).toBe(false);
    expect(calls[1]!.ops).toContainEqual(['limit', [50]]);
  });

  it('reads an incident with names, a ride summary from panel_rides and the reported review', async () => {
    results.push(
      { data: { id: 'i1', reported_by: 'u1', against_user_id: 'u2', resolved_by: null, ride_id: 'r1', type: 'review_abuse', review_id: 'v1' }, error: null },
      { data: [{ id: 'u1', full_name: 'Carla', phone: '1' }, { id: 'u2', full_name: 'Diego', phone: '2' }], error: null },
      { data: { id: 'r1', status: 'completed', pickup_address: 'A', dropoff_address: 'B' }, error: null },
      { data: { id: 'v1', rating: 1, comment: 'x', is_visible: true, created_at: 't' }, error: null },
    );
    const detail = await panelReadService.getIncidentDetail('i1');
    expect(calls.map((c) => c.table)).toEqual(['panel_incident_reports', 'users', 'panel_rides', 'reviews']);
    expect(detail?.reporter).toEqual({ name: 'Carla', phone: '1' });
    expect(detail?.ride?.pickup_address).toBe('A');
  });

  it('skips the review for other incident types and answers null for an unknown incident', async () => {
    results.push(
      { data: { id: 'i2', reported_by: 'u1', against_user_id: null, resolved_by: null, ride_id: null, type: 'sos', review_id: null }, error: null },
      { data: [{ id: 'u1', full_name: 'Carla', phone: '1' }], error: null },
      { data: null, error: null },
    );
    const sos = await panelReadService.getIncidentDetail('i2');
    expect(calls.map((c) => c.table)).toEqual(['panel_incident_reports', 'users']);
    expect(sos).toMatchObject({ against: null, resolver: null, ride: null, review: null });
    expect(await panelReadService.getIncidentDetail('missing')).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['panel_incident_reports', 'users', 'panel_incident_reports']);
  });

  it('answers null and reads nothing else for an incident that does not exist or an id that is not a uuid', async () => {
    expect(await panelReadService.getIncidentDetail('00000000-0000-0000-0000-000000000000')).toBeNull();
    results.push({ data: null, error: BAD_UUID });
    expect(await panelReadService.getIncidentDetail('abc')).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(['panel_incident_reports', 'panel_incident_reports']);
    expect(calls[0]!.ops).toContainEqual(['maybeSingle', []]);
  });

  it('throws when the incident cannot be read, and reads nothing else', async () => {
    results.push({ data: null, error: new Error('incident read failed') });
    await expect(panelReadService.getIncidentDetail('i1')).rejects.toThrow('incident read failed');
    expect(calls.map((c) => c.table)).toEqual(['panel_incident_reports']);
  });

  it('flags the ride and the review as unavailable only when their reads fail', async () => {
    const incident = { id: 'i1', reported_by: 'u1', against_user_id: null, resolved_by: null, ride_id: 'r1', type: 'review_abuse', review_id: 'v1' };
    results.push(
      { data: incident, error: null },
      { data: [{ id: 'u1', full_name: 'Carla', phone: '1' }], error: null },
      { data: null, error: new Error('ride read failed') },
      { data: { id: 'v1', rating: 1, comment: null, is_visible: true, created_at: 't' }, error: null },
    );
    const noRide = await panelReadService.getIncidentDetail('i1');
    expect(noRide).toMatchObject({ ride: null, rideUnavailable: true, reviewUnavailable: false });
    expect(noRide?.review?.id).toBe('v1');

    results.length = 0;
    results.push(
      { data: incident, error: null },
      { data: [{ id: 'u1', full_name: 'Carla', phone: '1' }], error: null },
      { data: { id: 'r1', status: 'completed', pickup_address: 'A', dropoff_address: 'B' }, error: null },
      { data: null, error: new Error('review read failed') },
    );
    const noReview = await panelReadService.getIncidentDetail('i1');
    expect(noReview).toMatchObject({ review: null, reviewUnavailable: true, rideUnavailable: false });
    expect(noReview?.ride?.id).toBe('r1');
  });

  it('does not flag a ride or review the incident has none of', async () => {
    results.push(
      { data: { id: 'i2', reported_by: 'u1', against_user_id: null, resolved_by: null, ride_id: null, type: 'sos', review_id: null }, error: null },
    );
    expect(await panelReadService.getIncidentDetail('i2')).toMatchObject({
      ride: null, rideUnavailable: false, review: null, reviewUnavailable: false,
    });
  });

  it('leaves the names out when the people lookup fails (the page shows the ids)', async () => {
    results.push(
      { data: { id: 'i3', reported_by: 'u1', against_user_id: 'u2', resolved_by: null, ride_id: null, type: 'sos', review_id: null }, error: null },
      { data: null, error: new Error('users read failed') },
    );
    expect(await panelReadService.getIncidentDetail('i3')).toMatchObject({ reporter: null, against: null });
  });
});

describe('panelReadService.getLostItems', () => {
  /** The columns of panel_lost_items, in the view's order (00663). */
  const VIEW_COLUMNS = [
    'id', 'ride_id', 'reporter_id', 'driver_id', 'description', 'category', 'photo_urls', 'status',
    'driver_response', 'driver_found', 'return_fee_cup', 'resolved_by', 'created_at', 'updated_at', 'resolved_at',
  ];

  it('reads panel_lost_items newest first, 100 by default, without a status filter', async () => {
    results.push({ data: [{ id: 'l1' }], error: null });
    expect(await panelReadService.getLostItems()).toEqual([{ id: 'l1' }]);
    expect(calls[0]!.table).toBe('panel_lost_items');
    expect(calls[0]!.ops).toContainEqual(['order', ['created_at', { ascending: false }]]);
    expect(calls[0]!.ops).toContainEqual(['limit', [100]]);
    expect(calls[0]!.ops.some(([op]) => op === 'eq')).toBe(false);
  });

  it('filters by status only when given, with the limit asked for', async () => {
    await panelReadService.getLostItems({ status: 'found', limit: 20 });
    expect(calls[0]!.ops).toContainEqual(['eq', ['status', 'found']]);
    expect(calls[0]!.ops).toContainEqual(['limit', [20]]);
  });

  it('selects the view’s columns by name and none of the hidden ones', async () => {
    await panelReadService.getLostItems();
    const select = calls[0]!.ops.find(([op]) => op === 'select');
    const columns = String(select?.[1][0]).split(',').map((c) => c.trim());
    expect(columns).toEqual(VIEW_COLUMNS);
    for (const hidden of ['admin_notes', 'return_location', 'return_notes', '*']) {
      expect(columns).not.toContain(hidden);
    }
  });

  it('answers an empty list when there are no rows', async () => {
    results.push({ data: null, error: null });
    expect(await panelReadService.getLostItems()).toEqual([]);
  });

  it('throws the Supabase error', async () => {
    results.push({ data: null, error: new Error('lost items read failed') });
    await expect(panelReadService.getLostItems()).rejects.toThrow('lost items read failed');
  });
});

describe('product failures', () => {
  it('parses the RPC answer and drops malformed entries', () => {
    expect(parseProductFailures({
      days: 30,
      places_not_found: [{ name: 'Paladar X', requests: 2, last_seen: 't', imported: 0 }, { name: 5 }],
      push_outcomes: [{ app: 'client', outcome: 'denied', users: 3 }],
      push_reach: { riders_active: 10, riders_reachable: 4, drivers_active: 5, drivers_reachable: 5 },
      app_versions: [{ app: 'client', version: '1.7.3', platform: 'android', installs: 2 }],
      failed_payments: [{ reason: 'Invalid card number', payments: 4, last_seen: 't' }],
    })).toEqual({
      days: 30,
      placesNotFound: [{ name: 'Paladar X', requests: 2, lastSeen: 't', imported: 0 }],
      pushOutcomes: [{ app: 'client', outcome: 'denied', users: 3 }],
      pushReach: { ridersActive: 10, ridersReachable: 4, driversActive: 5, driversReachable: 5 },
      appVersions: [{ app: 'client', version: '1.7.3', platform: 'android', installs: 2 }],
      failedPayments: [{ reason: 'Invalid card number', payments: 4, lastSeen: 't' }],
    });
  });

  it('returns empty blocks for an answer it cannot read', () => {
    expect(parseProductFailures(null)).toEqual({
      days: 0, placesNotFound: [], pushOutcomes: [],
      pushReach: { ridersActive: 0, ridersReachable: 0, driversActive: 0, driversReachable: 0 },
      appVersions: [], failedPayments: [],
    });
  });

  it('calls get_product_failures with the period', async () => {
    mockRpc.mockResolvedValueOnce({ data: { days: 7 }, error: null });
    const r = await panelReadService.getProductFailures(7);
    expect(mockRpc).toHaveBeenCalledWith('get_product_failures', { p_days: 7 });
    expect(r.days).toBe(7);
  });

  it('throws the RPC error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('Admin only') });
    await expect(panelReadService.getProductFailures(7)).rejects.toThrow('Admin only');
  });
});
