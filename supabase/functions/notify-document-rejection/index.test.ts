import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real notify-document-rejection handler. supabase-js (esm.sh) is replaced
// with a fake client, and fetch is stubbed so the call to send-email is observed.
//
// The rejection e-mail carries the account's name and the admin's note. It goes only
// to an address mailable_user_emails (00635) calls proven, never to whatever the
// driver typed into the profile.

const db = vi.hoisted(() => ({
  email: null as string | null,
  proven: {} as Record<string, string>,
}));

const DRIVER_USER = '00000000-0000-4000-8000-0000000000d1';

vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.single = async () => ({
        data: {
          document_type: 'drivers_license',
          driver_profiles: { user_id: DRIVER_USER, users: { full_name: 'Dani', email: db.email } },
        },
        error: null,
      });
      return q;
    },
    rpc: (_fn: string, args: { p_user_ids: string[] }) => Promise.resolve({
      data: args.p_user_ids.filter((id) => id in db.proven).map((id) => ({ user_id: id, email: db.proven[id] })),
      error: null,
    }),
  }),
}));

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
};

let handler: (req: Request) => Promise<Response>;
const sent: Array<{ recipient_email: string }> = [];

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => env[k] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent.push({ recipient_email: JSON.parse(init.body).recipient_email });
    return new Response('{}', { status: 200 });
  }));
  await import('./index.ts');
});

beforeEach(() => {
  sent.length = 0;
  db.email = 'typed@x.test';
  db.proven = {};
});

const reject = () => handler(new Request('https://example.supabase.co/functions/v1/notify-document-rejection', {
  method: 'POST',
  headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ documentId: 'doc-1', reasonCodes: [], note: 'Foto borrosa' }),
}));

describe('notify-document-rejection', () => {
  it('does not mail an address the driver typed but never proved', async () => {
    const res = await reject();
    expect(await res.json()).toEqual({ sent: false, reason: 'no_proven_email' });
    expect(sent).toEqual([]);
  });

  it('mails the proven address', async () => {
    db.email = ' Dani@X.test ';
    db.proven = { [DRIVER_USER]: 'Dani@X.test' };
    const res = await reject();
    expect(await res.json()).toEqual({ sent: true });
    expect(sent).toEqual([{ recipient_email: 'Dani@X.test' }]);
  });
});
