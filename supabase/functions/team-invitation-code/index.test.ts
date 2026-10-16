import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real team-invitation-code handler. Replaced: supabase-js (imported from esm.sh,
// which vitest cannot load) with a client whose rpc and auth.admin calls the tests script;
// the rate limiter (DB-backed); and fetch, so the call to send-email is observed.
const limiter = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  // Like the real one: the caller's CORS headers go on the 429, so the browser can read it.
  rateLimitResponse: vi.fn(
    (retryAfterMs: number, corsHeaders: Record<string, string> = {}) =>
      new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
        },
      }),
  ),
}));
vi.mock('../_shared/rate-limiter.ts', () => limiter);

const sb = vi.hoisted(() => ({
  rpc: vi.fn(),
  createUser: vi.fn(),
  updateUserById: vi.fn(),
  // from(table).update(values).eq(column, value).select(cols): the chosen-password mark.
  markUpdate: vi.fn(),
  // When set, createClient throws it (as supabase-js does without a URL).
  clientError: null as Error | null,
}));
vi.mock('https://esm.sh/@supabase/supabase-js@2.108.2', () => ({
  createClient: () => {
    if (sb.clientError) throw sb.clientError;
    return {
      rpc: sb.rpc,
      from: (table: string) => ({
        update: (values: unknown) => ({
          eq: (column: string, value: unknown) => ({
            select: (cols: string) => sb.markUpdate(table, values, column, value, cols),
          }),
        }),
      }),
      auth: { admin: { createUser: sb.createUser, updateUserById: sb.updateUserById } },
    };
  },
}));

// Fake key material: same shape as a real secret key, not a credential.
const SERVICE_KEY = 'sb_secret_TESTtestTESTtestTESTtest01';
const TOKEN = 'a'.repeat(64);
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const NEW_ID = '00000000-0000-4000-8000-0000000000bb';
const ORIGIN = 'https://admin.tricigo.com';

const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }),
  ALLOWED_ORIGINS: `${ORIGIN},https://tricigo.com`,
};

const mail = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"success":true}', { status: 200 }));

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal('Deno', {
    env: { get: (name: string) => env[name] },
    serve: (h: typeof handler) => {
      handler = h;
    },
  });
  vi.stubGlobal('fetch', mail);
  await import('./index.ts');
});

beforeEach(() => {
  limiter.rateLimit.mockReset();
  limiter.rateLimit.mockResolvedValue({ allowed: true, remaining: 1, retryAfterMs: 0 });
  limiter.rateLimitResponse.mockClear();
  sb.rpc.mockReset();
  sb.createUser.mockReset();
  sb.updateUserById.mockReset();
  sb.markUpdate.mockReset();
  sb.markUpdate.mockResolvedValue({ data: [{ id: USER_ID }], error: null });
  sb.clientError = null;
  mail.mockReset();
  mail.mockImplementation(async () => new Response('{"success":true}', { status: 200 }));
});

/** Each RPC answers what the test gives it. */
function rpcAnswers(answers: Record<string, unknown>) {
  sb.rpc.mockImplementation(async (fn: string) => ({ data: answers[fn] ?? null, error: null }));
}

function post(body: unknown) {
  return handler(
    new Request('https://example.supabase.co/functions/v1/team-invitation-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'x-forwarded-for': '152.206.10.20' },
      body: JSON.stringify(body),
    }),
  );
}

const ISSUED = {
  result: 'issued', code: '048213', email: 'info@bacoagency.com', full_name: 'Baco', account_exists: false, expires_in_s: 600,
};
const CHECK_NEW = { result: 'ok', email: 'info@bacoagency.com', role: 'marketing', full_name: 'Baco', case: 'new', user_id: null };

describe('team-invitation-code', () => {
  it('answers CORS for the panel origin', async () => {
    const res = await handler(new Request('https://example.supabase.co/functions/v1/team-invitation-code', {
      method: 'OPTIONS', headers: { Origin: ORIGIN },
    }));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('puts the CORS origin on a POST answer', async () => {
    const res = await post({ action: 'send', token: 'nope' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('answers not_found for a malformed token without touching the database', async () => {
    const res = await post({ action: 'send', token: 'nope' });
    expect(await res.json()).toEqual({ result: 'not_found' });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it('answers 400 to a body that is not an object', async () => {
    expect((await post(null)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it('answers 500 with CORS when the client cannot be built', async () => {
    sb.clientError = new Error('supabaseUrl is required.');
    const res = await post({ action: 'send', token: TOKEN });
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  describe('send', () => {
    it('is limited per client IP before anything else, and the 429 carries CORS', async () => {
      limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
      const res = await post({ action: 'send', token: TOKEN });
      expect(res.status).toBe(429);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(limiter.rateLimit).toHaveBeenCalledWith('team-code-send-ip:152.206.10.20', 10, 3_600_000);
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('passes on a refusal from the database and mails nothing', async () => {
      rpcAnswers({ team_invitation_code_issue: { result: 'cooldown', retry_after_s: 42 } });
      const res = await post({ action: 'send', token: TOKEN });
      expect(await res.json()).toEqual({ result: 'cooldown', retry_after_s: 42 });
      expect(mail).not.toHaveBeenCalled();
    });

    it('mails the code through send-email and answers without the code or the address', async () => {
      rpcAnswers({ team_invitation_code_issue: ISSUED });
      const res = await post({ action: 'send', token: TOKEN });
      const body = await res.json();
      expect(body).toEqual({ result: 'sent', account_exists: false, expires_in_s: 600, invitee_name: 'Baco' });
      expect(JSON.stringify(body)).not.toContain('048213');
      expect(JSON.stringify(body)).not.toContain('bacoagency');
      expect(sb.rpc).toHaveBeenCalledWith('team_invitation_code_issue', { p_token: TOKEN });
      const [url, init] = mail.mock.calls[0];
      expect(url).toBe('https://example.supabase.co/functions/v1/send-email');
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_KEY}`);
      // The call has a deadline, so a hung send-email ends in send_failed.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({
        template: 'team_invitation_code',
        recipient_email: 'info@bacoagency.com',
        data: { code: '048213', email: 'info@bacoagency.com' },
      });
    });

    it('answers send_failed when send-email refuses', async () => {
      rpcAnswers({ team_invitation_code_issue: ISSUED });
      mail.mockImplementation(async () => new Response('{"error":"x"}', { status: 500 }));
      expect(await (await post({ action: 'send', token: TOKEN })).json()).toEqual({ result: 'send_failed' });
    });

    it('answers send_failed when the call to send-email fails or times out', async () => {
      rpcAnswers({ team_invitation_code_issue: ISSUED });
      mail.mockImplementation(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      });
      expect(await (await post({ action: 'send', token: TOKEN })).json()).toEqual({ result: 'send_failed' });
    });

    it('answers 500 and mails nothing when issued comes without the code', async () => {
      rpcAnswers({ team_invitation_code_issue: { ...ISSUED, code: undefined } });
      expect((await post({ action: 'send', token: TOKEN })).status).toBe(500);
      expect(mail).not.toHaveBeenCalled();
    });

    it('answers 500 when the database fails', async () => {
      sb.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
      expect((await post({ action: 'send', token: TOKEN })).status).toBe(500);
    });
  });

  describe('verify', () => {
    const verify = (extra: Record<string, unknown> = {}) =>
      post({ action: 'verify', token: TOKEN, code: '048213', password: 'secreta123', full_name: 'Nina Baco', ...extra });

    it('is limited per client IP', async () => {
      limiter.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
      expect((await verify()).status).toBe(429);
      expect(limiter.rateLimit).toHaveBeenCalledWith('team-code-verify-ip:152.206.10.20', 30, 3_600_000);
    });

    it('refuses a bad password before spending the code', async () => {
      expect(await (await verify({ password: 'corta12' })).json()).toEqual({ result: 'bad_password' });
      expect(await (await verify({ password: 'x'.repeat(73) })).json()).toEqual({ result: 'bad_password' });
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('counts the password limit in bytes, as bcrypt does', async () => {
      // 37 × 'ñ' is 74 bytes in UTF-8: refused before the code.
      expect(await (await verify({ password: 'ñ'.repeat(37) })).json()).toEqual({ result: 'bad_password' });
      expect(sb.rpc).not.toHaveBeenCalled();
      // 36 × 'ñ' is 72 bytes: allowed, the code is checked.
      rpcAnswers({ team_invitation_code_check: { result: 'wrong_code', attempts_left: 4 } });
      expect(await (await verify({ password: 'ñ'.repeat(36) })).json()).toEqual({ result: 'wrong_code', attempts_left: 4 });
      expect(sb.rpc).toHaveBeenCalledWith('team_invitation_code_check', { p_token: TOKEN, p_code: '048213' });
    });

    it('refuses a name over 80 characters before spending the code', async () => {
      expect(await (await verify({ full_name: 'x'.repeat(81) })).json()).toEqual({ result: 'bad_name' });
      expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('removes every space from the code, so a pasted "048 213" is not a wasted attempt', async () => {
      rpcAnswers({ team_invitation_code_check: { result: 'wrong_code', attempts_left: 4 } });
      await verify({ code: ' 048 213\t' });
      expect(sb.rpc).toHaveBeenCalledWith('team_invitation_code_check', { p_token: TOKEN, p_code: '048213' });
    });

    it('passes on a wrong code with the attempts left, and touches no account', async () => {
      rpcAnswers({ team_invitation_code_check: { result: 'wrong_code', attempts_left: 3 } });
      const body = await (await verify()).json();
      expect(body).toEqual({ result: 'wrong_code', attempts_left: 3 });
      expect(sb.createUser).not.toHaveBeenCalled();
      expect(sb.updateUserById).not.toHaveBeenCalled();
    });

    it('answers 500 when the check says ok without an address', async () => {
      rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, email: undefined } });
      expect((await verify()).status).toBe(500);
      expect(sb.createUser).not.toHaveBeenCalled();
    });

    it('creates a new account with a confirmed address and accepts the invitation for it', async () => {
      rpcAnswers({
        team_invitation_code_check: CHECK_NEW,
        accept_team_invitation_by_code: { result: 'accepted', role: 'marketing' },
      });
      sb.createUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
      expect(await (await verify()).json()).toEqual({ result: 'accepted', email: 'info@bacoagency.com', role: 'marketing' });
      expect(sb.createUser).toHaveBeenCalledWith({
        email: 'info@bacoagency.com',
        password: 'secreta123',
        email_confirm: true,
        user_metadata: { full_name: 'Nina Baco' },
      });
      expect(sb.rpc).toHaveBeenCalledWith('accept_team_invitation_by_code', { p_token: TOKEN, p_user: NEW_ID });
      // A new account gets its mark from the accept step, not from here.
      expect(sb.markUpdate).not.toHaveBeenCalled();
    });

    it('strips control characters from the name', async () => {
      rpcAnswers({
        team_invitation_code_check: CHECK_NEW,
        accept_team_invitation_by_code: { result: 'accepted', role: 'marketing' },
      });
      sb.createUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
      await verify({ full_name: 'Nina\u0000 Baco\u001b\u007f' });
      expect(sb.createUser.mock.calls[0][0].user_metadata).toEqual({ full_name: 'Nina Baco' });
    });

    it("uses the invitation's name when the form sends none", async () => {
      rpcAnswers({
        team_invitation_code_check: CHECK_NEW,
        accept_team_invitation_by_code: { result: 'accepted', role: 'marketing' },
      });
      sb.createUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
      await verify({ full_name: '   ' });
      expect(sb.createUser.mock.calls[0][0].user_metadata).toEqual({ full_name: 'Baco' });
    });

    it('sets the password on an existing account instead of creating one', async () => {
      rpcAnswers({
        team_invitation_code_check: { ...CHECK_NEW, case: 'proven', user_id: USER_ID },
        accept_team_invitation_by_code: { result: 'accepted', role: 'admin' },
      });
      sb.updateUserById.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
      expect(await (await verify()).json()).toEqual({ result: 'accepted', email: 'info@bacoagency.com', role: 'admin' });
      expect(sb.updateUserById).toHaveBeenCalledWith(USER_ID, { password: 'secreta123', email_confirm: true });
      expect(sb.createUser).not.toHaveBeenCalled();
      // The mark goes first, so a failure after the password write cannot leave it unmarked.
      expect(sb.markUpdate).toHaveBeenCalledWith('users', { password_set_at: expect.any(String) }, 'id', USER_ID, 'id');
      expect(sb.markUpdate.mock.invocationCallOrder[0]).toBeLessThan(sb.updateUserById.mock.invocationCallOrder[0]);
    });

    it('does not touch the password of an existing account when the mark cannot be written', async () => {
      rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, case: 'proven', user_id: USER_ID } });
      sb.markUpdate.mockResolvedValue({ data: null, error: { message: 'db down' } });
      expect(await (await verify()).json()).toEqual({ result: 'try_again' });
      expect(sb.updateUserById).not.toHaveBeenCalled();
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('does not touch the password of an existing account when the mark finds no row', async () => {
      rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, case: 'password_only', user_id: USER_ID } });
      sb.markUpdate.mockResolvedValue({ data: [], error: null });
      expect(await (await verify()).json()).toEqual({ result: 'try_again' });
      expect(sb.updateUserById).not.toHaveBeenCalled();
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('creates or touches no account for a case the code may not serve', async () => {
      for (const kase of ['needs_google', 'blocked', 'something_else']) {
        rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, case: kase, user_id: USER_ID } });
        expect(await (await verify()).json()).toEqual({ result: 'needs_google' });
      }
      expect(sb.createUser).not.toHaveBeenCalled();
      expect(sb.markUpdate).not.toHaveBeenCalled();
      expect(sb.updateUserById).not.toHaveBeenCalled();
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('answers try_again for an existing-account case without the account id, and touches nothing', async () => {
      for (const kase of ['proven', 'password_only']) {
        rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, case: kase, user_id: null } });
        expect(await (await verify()).json()).toEqual({ result: 'try_again' });
      }
      expect(sb.createUser).not.toHaveBeenCalled();
      expect(sb.markUpdate).not.toHaveBeenCalled();
      expect(sb.updateUserById).not.toHaveBeenCalled();
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('answers weak_password when GoTrue refuses the password, and accepts nothing', async () => {
      rpcAnswers({ team_invitation_code_check: CHECK_NEW });
      sb.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'weak_password', message: 'weak' } });
      expect(await (await verify()).json()).toEqual({ result: 'weak_password' });
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('answers try_again when GoTrue fails for another reason', async () => {
      rpcAnswers({ team_invitation_code_check: CHECK_NEW });
      sb.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'taken' } });
      expect(await (await verify()).json()).toEqual({ result: 'try_again' });
    });

    it('answers weak_password or try_again when GoTrue refuses the new password of an existing account', async () => {
      rpcAnswers({ team_invitation_code_check: { ...CHECK_NEW, case: 'proven', user_id: USER_ID } });
      sb.updateUserById.mockResolvedValue({ data: { user: null }, error: { code: 'weak_password', message: 'weak' } });
      expect(await (await verify()).json()).toEqual({ result: 'weak_password' });
      sb.updateUserById.mockResolvedValue({ data: { user: null }, error: { code: 'unexpected_failure', message: 'x' } });
      expect(await (await verify()).json()).toEqual({ result: 'try_again' });
      expect(sb.rpc).not.toHaveBeenCalledWith('accept_team_invitation_by_code', expect.anything());
    });

    it('answers try_again, not 500, when the accept step fails after the code was spent', async () => {
      sb.rpc.mockImplementation(async (fn: string) =>
        fn === 'accept_team_invitation_by_code'
          ? { data: null, error: { message: 'deadlock detected' } }
          : { data: CHECK_NEW, error: null },
      );
      sb.createUser.mockResolvedValue({ data: { user: { id: NEW_ID } }, error: null });
      const res = await verify();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: 'try_again' });
    });

    it('answers try_again, not 500, when a call throws after the code was spent', async () => {
      rpcAnswers({ team_invitation_code_check: CHECK_NEW });
      sb.createUser.mockRejectedValue(new Error('network down'));
      const res = await verify();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: 'try_again' });
    });

    it('passes on a refusal from the accept step', async () => {
      rpcAnswers({
        team_invitation_code_check: { ...CHECK_NEW, case: 'password_only', user_id: USER_ID },
        accept_team_invitation_by_code: { result: 'canceled' },
      });
      sb.updateUserById.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
      expect(await (await verify()).json()).toEqual({ result: 'canceled' });
    });
  });

  it('refuses an unknown action', async () => {
    expect((await post({ action: 'other', token: TOKEN })).status).toBe(400);
  });
});
