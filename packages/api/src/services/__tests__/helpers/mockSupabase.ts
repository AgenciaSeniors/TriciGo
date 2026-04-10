import { vi } from 'vitest';

/**
 * Creates a fully chainable Supabase query builder mock.
 * Every query-builder method returns `chain` (self-reference),
 * so any chain like .from().select().eq().eq().maybeSingle() works
 * regardless of depth.
 */
export function createMockQueryChain(
  response: { data: any; error: any } = { data: null, error: null },
) {
  const chain: Record<string, any> = {};
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is',
    'or', 'and', 'not', 'ilike', 'like', 'contains',
    'order', 'limit', 'range', 'textSearch',
    'filter', 'match', 'overlaps', 'containedBy',
    'returns',
  ];

  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }

  // Terminal methods return the response
  chain.single = vi.fn(() => Promise.resolve(response));
  chain.maybeSingle = vi.fn(() => Promise.resolve(response));
  chain.csv = vi.fn(() => Promise.resolve(response));

  // Make chain thenable so `await supabase.from(...).select(...)` works
  chain.then = vi.fn((resolve: any) => resolve(response));

  return chain;
}

export function createMockSupabase() {
  const defaultChain = createMockQueryChain();

  return {
    from: vi.fn(() => defaultChain),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve({ data: { user: null }, error: null }),
      ),
      getSession: vi.fn(() =>
        Promise.resolve({ data: { session: null }, error: null }),
      ),
      signInWithOtp: vi.fn(),
      verifyOtp: vi.fn(),
      signOut: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithOAuth: vi.fn(),
      updateUser: vi.fn(),
      admin: {
        listUsers: vi.fn(() =>
          Promise.resolve({ data: { users: [] }, error: null }),
        ),
      },
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(),
        getPublicUrl: vi.fn(),
        createSignedUrl: vi.fn(),
      })),
    },
    functions: {
      invoke: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
    // Expose for per-test customization
    _chain: defaultChain,
    _createChain: createMockQueryChain,
  };
}

/* ─── Valid UUID fixtures ──────────────────────────────────── */
export const UUID = {
  USER_1: '00000000-0000-4000-8000-000000000001',
  USER_2: '00000000-0000-4000-8000-000000000002',
  USER_3: '00000000-0000-4000-8000-000000000003',
  DRIVER_1: '00000000-0000-4000-8000-000000000011',
  DRIVER_2: '00000000-0000-4000-8000-000000000012',
  RIDE_1: '00000000-0000-4000-8000-000000000021',
  RIDE_2: '00000000-0000-4000-8000-000000000022',
  RIDE_3: '00000000-0000-4000-8000-000000000023',
  REVIEW_1: '00000000-0000-4000-8000-000000000031',
  REVIEW_2: '00000000-0000-4000-8000-000000000032',
  DISPUTE_1: '00000000-0000-4000-8000-000000000041',
  PROMO_1: '00000000-0000-4000-8000-000000000051',
  ADMIN_1: '00000000-0000-4000-8000-000000000061',
  MSG_1: '00000000-0000-4000-8000-000000000071',
  MSG_2: '00000000-0000-4000-8000-000000000072',
  VEHICLE_1: '00000000-0000-4000-8000-000000000081',
  DOC_1: '00000000-0000-4000-8000-000000000091',
  SPLIT_1: '00000000-0000-4000-8000-0000000000a1',
  CONFIG_1: '00000000-0000-4000-8000-0000000000b1',
  CONFIG_2: '00000000-0000-4000-8000-0000000000b2',
  WAYPOINT_1: '00000000-0000-4000-8000-0000000000c1',
  WAYPOINT_2: '00000000-0000-4000-8000-0000000000c2',
  INSURANCE_1: '00000000-0000-4000-8000-0000000000d1',
  WALLET_1: '00000000-0000-4000-8000-0000000000e1',
  TRANSFER_1: '00000000-0000-4000-8000-0000000000f1',
  PENALTY_1: '00000000-0000-4000-8000-000000000101',
  SCORE_EVT_1: '00000000-0000-4000-8000-000000000111',
  TOKEN_1: '00000000-0000-4000-8000-000000000121',
} as const;
