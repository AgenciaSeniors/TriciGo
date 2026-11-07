import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real send-sms handler. Replaced: supabase-js (esm.sh) with a fake client that records
// the sms_log rows, and the D7 sender, whose options are what these tests look at.
const d7 = vi.hoisted(() => ({ sendSmsViaD7: vi.fn() }));
vi.mock('../_shared/d7.ts', () => d7);

const db = vi.hoisted(() => ({ logged: [] as Array<Record<string, unknown>> }));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        db.logged.push(row);
        return { error: null };
      },
    }),
  }),
}));

const KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: KEY }),
};

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  await import('./index.ts');
});

beforeEach(() => {
  d7.sendSmsViaD7.mockReset();
  d7.sendSmsViaD7.mockResolvedValue({ ok: true, status: 200, requestId: 'req-1' });
  db.logged = [];
});

const send = (body: Record<string, unknown>, apikey = KEY) =>
  handler(
    new Request('https://example.supabase.co/functions/v1/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey },
      body: JSON.stringify({ phone: '+5355512345', body: 'TriciGo: hola', event_type: 'fleet_invite', ...body }),
    }),
  );

/** The options the handler gave the D7 sender. */
const d7Options = () => d7.sendSmsViaD7.mock.calls[0][2] as Record<string, unknown>;

describe('send-sms data coding', () => {
  it('asks D7 for text with gsm7: true', async () => {
    const res = await send({ gsm7: true });
    expect(res.status).toBe(200);
    expect(d7Options().dataCoding).toBe('text');
  });

  it('does not ask for it without the field', async () => {
    await send({});
    expect(d7Options()).toEqual({ tracker: expect.anything(), eventType: 'fleet_invite' });
  });

  it.each([[false], [null], ['true'], [1], [{}]])('does not ask for it with gsm7: %j', async (gsm7) => {
    await send({ gsm7 });
    expect(d7Options()).toEqual({ tracker: expect.anything(), eventType: 'fleet_invite' });
  });

  it('passes the phone and the text as they came', async () => {
    await send({ gsm7: true });
    expect(d7.sendSmsViaD7.mock.calls[0].slice(0, 2)).toEqual(['+5355512345', 'TriciGo: hola']);
  });

  it('writes the same sms_log row either way', async () => {
    await send({ gsm7: true });
    await send({});
    expect(db.logged).toHaveLength(2);
    expect(db.logged[0]).toEqual(db.logged[1]);
    expect(Object.keys(db.logged[0]).sort()).toEqual(
      ['event_type', 'message_body', 'phone', 'ride_id', 'status', 'twilio_sid', 'user_id'],
    );
  });

  it('stays internal: a wrong key is refused before anything is sent', async () => {
    const res = await send({ gsm7: true }, 'not-the-key');
    expect(res.status).toBe(401);
    expect(d7.sendSmsViaD7).not.toHaveBeenCalled();
  });
});
