// ============================================================
// TriciGo — driver calls that need a session must not leave without one
//
// 2026-09-21: a driver app whose in-memory session was gone (the keystore read
// failed for ~23 min; the server-side session was intact all along) kept
// operating as role `anon`: 25 heartbeats, position updates and a "Conectarme"
// tap, every one a 401. The tap surfaced the raw RLS failure
// `permission denied for function current_user_role` in the toast, and the
// background task burned a request every 55 s for nothing.
//
// The rule: a session-only write checks for a session FIRST and reports
// `session_expired`, a code the UI can translate; the periodic pushes
// (heartbeat, position) simply skip when there is no session.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockGetSession = vi.fn();
const fromCalls: string[] = [];
let updateResult: { data: unknown; error: unknown } = { data: [{ id: 'dp-1' }], error: null };

function chainable(terminal: () => { data: unknown; error: unknown }) {
  const obj: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => obj;
  for (const m of ['select', 'eq', 'limit', 'update', 'order']) obj[m] = vi.fn(self);
  obj.maybeSingle = vi.fn(async () => terminal());
  obj.single = vi.fn(async () => terminal());
  obj.then = vi.fn((resolve: (v: unknown) => void) => resolve(terminal()));
  return obj;
}

vi.mock('../client', () => ({
  getSupabaseClient: () => ({
    auth: { getSession: mockGetSession },
    from: vi.fn((table: string) => {
      fromCalls.push(table);
      return chainable(() => (table === 'vehicles' ? { data: { id: 'veh-1' }, error: null } : updateResult));
    }),
    rpc: mockRpc,
  }),
}));

vi.mock('@tricigo/utils', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/_storage-upload', () => ({ uploadFileFromUri: vi.fn() }));
vi.mock('../services/notification.service', () => ({
  notificationService: { notifyUser: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/exchange-rate.service', () => ({ exchangeRateService: {} }));

const { driverService } = await import('../services/driver.service');

const withSession = () => mockGetSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } }, error: null });
const withoutSession = () => mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

beforeEach(() => {
  mockRpc.mockReset();
  mockGetSession.mockReset();
  fromCalls.length = 0;
  updateResult = { data: [{ id: 'dp-1' }], error: null };
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('setOnlineStatus without a session', () => {
  it('reports session_expired before touching the database', async () => {
    withoutSession();

    await expect(driverService.setOnlineStatus('dp-1', true)).rejects.toThrow('session_expired');
    expect(fromCalls).toEqual([]);
  });

  it('still goes online normally when a session exists', async () => {
    withSession();

    await expect(driverService.setOnlineStatus('dp-1', true)).resolves.toBeUndefined();
    expect(fromCalls).toContain('driver_profiles');
  });

  it('translates an RLS "permission denied" on the write into session_expired', async () => {
    // Belt and braces: getSession() said "session" but the request left as
    // anon anyway (a stale in-memory session). The policy on driver_profiles
    // then trips over current_user_role(), which anon may not execute.
    withSession();
    updateResult = {
      data: null,
      error: { code: '42501', message: 'permission denied for function current_user_role' },
    };

    await expect(driverService.setOnlineStatus('dp-1', true)).rejects.toThrow('session_expired');
  });
});

describe('periodic pushes without a session', () => {
  it('sendHeartbeat skips the RPC', async () => {
    withoutSession();

    await expect(driverService.sendHeartbeat('dp-1')).resolves.toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sendHeartbeat still fires with a session', async () => {
    withSession();

    await driverService.sendHeartbeat('dp-1');
    expect(mockRpc).toHaveBeenCalledWith('driver_heartbeat', { p_driver_id: 'dp-1' });
  });

  it('updateDriverPosition skips the RPC', async () => {
    withoutSession();

    await expect(
      driverService.updateDriverPosition({ driverId: 'dp-1', latitude: 23.1, longitude: -82.3 }),
    ).resolves.toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
