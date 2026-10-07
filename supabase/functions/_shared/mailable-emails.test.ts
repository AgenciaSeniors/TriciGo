import { describe, expect, it, vi } from 'vitest';
import { fetchMailableEmail, fetchMailableEmails, MAILABLE_CHUNK, type MailableEmailClient } from './mailable-emails';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

// A stand-in for the service-role client: answers mailable_user_emails from a table of
// proven addresses, the way migration 00635's function does.
function client(proven: Record<string, string>, error: { message: string } | null = null) {
  const rpc = vi.fn((fn: string, args: { p_user_ids: string[] }) => {
    if (error) return Promise.resolve({ data: null, error });
    const data = args.p_user_ids.filter((id) => id in proven).map((id) => ({ user_id: id, email: proven[id] }));
    return Promise.resolve({ data, error: null });
  });
  return { rpc } satisfies MailableEmailClient;
}

describe('fetchMailableEmails', () => {
  it('asks mailable_user_emails and returns only the accounts whose address is proven', async () => {
    const c = client({ [A]: 'a@x.test' });
    const map = await fetchMailableEmails(c, [A, B]);
    expect(c.rpc).toHaveBeenCalledWith('mailable_user_emails', { p_user_ids: [A, B] });
    expect([...map]).toEqual([[A, 'a@x.test']]);
  });

  it('does not call the database for an empty list', async () => {
    const c = client({});
    expect((await fetchMailableEmails(c, [])).size).toBe(0);
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('fails closed: when the check errors (00635 not applied) nobody is mailed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = client({ [A]: 'a@x.test' }, { message: 'Could not find the function public.mailable_user_emails' });
    expect((await fetchMailableEmails(c, [A])).size).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('fails closed when the call itself throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = { rpc: vi.fn(() => Promise.reject(new Error('network'))) } satisfies MailableEmailClient;
    expect((await fetchMailableEmails(c, [A])).size).toBe(0);
    err.mockRestore();
  });

  it('never returns the phone-OTP placeholder or an empty address', async () => {
    const c = client({ [A]: 'phone_5355555555@tricigo.app', [B]: '  ', [C]: ' c@x.test ' });
    expect([...(await fetchMailableEmails(c, [A, B, C]))]).toEqual([[C, 'c@x.test']]);
  });

  it('ignores rows that are not what the function returns', async () => {
    const c = { rpc: vi.fn(() => Promise.resolve({ data: [{ user_id: A }, null, 'x', { user_id: B, email: 7 }], error: null })) };
    expect((await fetchMailableEmails(c, [A, B])).size).toBe(0);
  });

  it('asks once per id and in chunks, so a campaign of thousands stays within a request body', async () => {
    const ids = Array.from({ length: MAILABLE_CHUNK * 2 + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const proven = Object.fromEntries(ids.map((id) => [id, `${id}@x.test`]));
    const c = client(proven);
    const map = await fetchMailableEmails(c, [...ids, ids[0]]);
    expect(c.rpc).toHaveBeenCalledTimes(3);
    expect(c.rpc.mock.calls.map(([, args]) => args.p_user_ids.length)).toEqual([MAILABLE_CHUNK, MAILABLE_CHUNK, 1]);
    expect(map.size).toBe(ids.length);
  });
});

describe('fetchMailableEmail', () => {
  it('returns the proven address of one account', async () => {
    expect(await fetchMailableEmail(client({ [A]: 'a@x.test' }), A)).toBe('a@x.test');
  });

  it('returns null when the address is not proven, or there is no account id', async () => {
    const c = client({});
    expect(await fetchMailableEmail(c, A)).toBeNull();
    expect(await fetchMailableEmail(c, null)).toBeNull();
    expect(c.rpc).toHaveBeenCalledTimes(1);
  });
});
