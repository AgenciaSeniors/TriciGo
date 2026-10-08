import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real process-netopia-webhook handler on the paid path. Replaced:
//  - supabase-js (esm.sh): an in-memory payment_intents table and platform_config;
//  - jose (esm.sh): never reached, the IPNs here carry no Verification-token;
//  - the rate limiter (DB-backed): always has room;
//  - fetch: NETOPIA's status re-query answers "paid"; send-push and the receipt
//    function answer 200.
// What it pins: a credit that fails must leave the intent claimable again, and a
// delivery that finds another run holding the intent must be retried, not ACKed.
vi.mock('../_shared/rate-limiter.ts', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 49, retryAfterMs: 0 })),
  rateLimitResponse: vi.fn(() => new Response('{}', { status: 429 })),
}));

vi.mock('https://esm.sh/jose@5.9.6', () => ({
  decodeProtectedHeader: () => {
    throw new Error('jose is not expected in these tests');
  },
  importX509: async () => {
    throw new Error('jose is not expected in these tests');
  },
}));

type Intent = {
  id: string;
  status: string;
  user_id: string;
  amount_cup: number;
  intent_type: string;
  corporate_account_id: string | null;
  payment_provider: string;
  stripe_payment_intent_id: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
  error_message?: string | null;
};

const db = vi.hoisted(() => ({
  intents: new Map<string, Record<string, unknown>>(),
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
  rpcCommitsThenFails: false,
}));

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

/** The claim filter the handler builds; anything else is a test failure. */
function orPredicate(f: string): Pred {
  const m = /^status\.in\.\(([^)]*)\),and\(status\.eq\.processing,updated_at\.lt\."([^"]+)"\)$/.exec(f);
  if (!m) throw new Error(`unexpected or() filter: ${f}`);
  const statuses = m[1].split(',');
  const cutoff = Date.parse(m[2]);
  return (r) =>
    statuses.includes(String(r.status)) || (r.status === 'processing' && Date.parse(String(r.updated_at)) < cutoff);
}

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => {
  function intentsQuery() {
    const preds: Pred[] = [];
    let patch: Row | null = null;
    const rows = () => [...db.intents.values()].filter((r) => preds.every((p) => p(r)));
    const run = () => {
      const hit = rows();
      if (patch) for (const r of hit) Object.assign(r, patch);
      return hit.map((r) => ({ ...r }));
    };
    const q: Record<string, unknown> = {
      select: () => q,
      update: (values: Row) => {
        patch = values;
        return q;
      },
      eq: (col: string, v: unknown) => {
        preds.push((r) => r[col] === v);
        return q;
      },
      neq: (col: string, v: unknown) => {
        preds.push((r) => r[col] !== v);
        return q;
      },
      in: (col: string, vs: unknown[]) => {
        preds.push((r) => vs.includes(r[col]));
        return q;
      },
      or: (f: string) => {
        preds.push(orPredicate(f));
        return q;
      },
      limit: () => q,
      single: async () => {
        const hit = run();
        return hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: 'not found' } };
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(ok, ko),
    };
    return q;
  }

  function configQuery() {
    const rows = [
      { key: 'netopia_environment', value: 'live' },
      { key: 'netopia_live_signature', value: 'TEST-POS-SIGNATURE' },
    ];
    const q: Record<string, unknown> = {
      select: () => q,
      in: () => q,
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(ok, ko),
    };
    return q;
  }

  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === 'payment_intents') return intentsQuery();
        if (table === 'platform_config') return configQuery();
        throw new Error(`unexpected table ${table}`);
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ fn, args });
        if (fn !== 'process_recharge_payment') throw new Error(`unexpected rpc ${fn}`);
        if (db.rpcError) return { data: null, error: db.rpcError };
        const intent = db.intents.get(String(args.p_payment_intent_id))!;
        intent.status = 'completed';
        if (db.rpcCommitsThenFails) return { data: null, error: { message: 'connection reset' } };
        return { data: 'txn-1', error: null };
      },
    }),
  };
});

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  NETOPIA_LIVE_API_KEY: 'test-api-key',
};

const ORDER = '8c1b25c4-9c44-4f05-b2a2-fa261f7611aa';
const NTP = '525385531';
const USER = '00000000-0000-4000-8000-0000000000aa';

const net = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.includes('/operation/status')) {
    return new Response(JSON.stringify({ payment: { status: 3 } }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
});

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', net);
  await import('./index.ts');
});

beforeEach(() => {
  db.intents.clear();
  db.rpcCalls = [];
  db.rpcError = null;
  db.rpcCommitsThenFails = false;
  net.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function seed(status: string, updatedAgoMs = 0): Intent {
  const intent: Intent = {
    id: ORDER,
    status,
    user_id: USER,
    amount_cup: 15400,
    intent_type: 'recharge',
    corporate_account_id: null,
    payment_provider: 'netopia',
    stripe_payment_intent_id: NTP,
    metadata: null,
    updated_at: new Date(Date.now() - updatedAgoMs).toISOString(),
  };
  db.intents.set(ORDER, intent);
  return intent;
}

function paidIpn(): Request {
  return new Request('https://example.supabase.co/functions/v1/process-netopia-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify({
      order: { orderID: ORDER },
      payment: { ntpID: NTP, status: 3, amount: 20.6, currency: 'USD' },
    }),
  });
}

const credits = () => db.rpcCalls.filter((c) => c.fn === 'process_recharge_payment').length;

describe('process-netopia-webhook paid path', () => {
  it('credits a pending intent once', async () => {
    seed('pending');
    const res = await handler(paidIpn());
    expect(res.status).toBe(200);
    expect(credits()).toBe(1);
    expect(db.intents.get(ORDER)!.status).toBe('completed');
  });

  it('acknowledges a completed intent without crediting it again', async () => {
    seed('completed');
    const res = await handler(paidIpn());
    expect(res.status).toBe(200);
    expect(credits()).toBe(0);
  });

  it('releases the intent when the credit fails, so the retry can credit it', async () => {
    seed('pending');
    db.rpcError = { message: 'canceling statement due to statement timeout' };
    const first = await handler(paidIpn());
    expect(first.status).toBe(500);
    expect(db.intents.get(ORDER)!.status).toBe('pending');
    expect(db.intents.get(ORDER)!.error_message).toBe('credit_failed: canceling statement due to statement timeout');

    db.rpcError = null;
    const retry = await handler(paidIpn());
    expect(retry.status).toBe(200);
    expect(credits()).toBe(2);
    expect(db.intents.get(ORDER)!.status).toBe('completed');
  });

  it('releases a failed credit to pending, never back to failed', async () => {
    // Going back to 'failed' would fire the payment-failed push and e-mail again.
    seed('failed');
    db.rpcError = { message: 'boom' };
    const res = await handler(paidIpn());
    expect(res.status).toBe(500);
    expect(db.intents.get(ORDER)!.status).toBe('pending');
  });

  it('asks NETOPIA to retry while another run holds the intent', async () => {
    seed('processing', 60_000);
    const res = await handler(paidIpn());
    expect(res.status).toBe(503);
    expect(credits()).toBe(0);
    expect(db.intents.get(ORDER)!.status).toBe('processing');
  });

  it('takes over a processing claim whose run died', async () => {
    seed('processing', 11 * 60_000);
    const res = await handler(paidIpn());
    expect(res.status).toBe(200);
    expect(credits()).toBe(1);
    expect(db.intents.get(ORDER)!.status).toBe('completed');
  });

  it('does not overwrite an intent the credit completed before its answer was lost', async () => {
    // The RPC committed (the row is completed) but the client saw an error.
    seed('pending');
    db.rpcCommitsThenFails = true;
    const res = await handler(paidIpn());
    expect(res.status).toBe(500);
    expect(credits()).toBe(1);
    expect(db.intents.get(ORDER)!.status).toBe('completed');
  });
});
