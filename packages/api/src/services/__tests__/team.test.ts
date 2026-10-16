import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

const mockRpc = vi.fn();
const mockInvoke = vi.fn();

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc, functions: { invoke: mockInvoke } }),
}));

import { teamService } from '../team.service';
import { AppError } from '../../errors';

describe('teamService', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('list calls list_team and returns members and invitations', async () => {
    const listing = { members: [{ user_id: 'u1' }], invitations: [] };
    mockRpc.mockResolvedValueOnce({ data: listing, error: null });
    await expect(teamService.list()).resolves.toEqual(listing);
    expect(mockRpc).toHaveBeenCalledWith('list_team', undefined);
  });

  it('invite sends a trimmed name, or null when it is blank', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'i1', link: 'L', expires_at: 'E', email_queued: true }, error: null });
    await teamService.invite('ana@gmail.com', 'admin', '  Ana  ');
    await teamService.invite('ana@gmail.com', 'admin', '   ');
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'create_team_invitation', { p_email: 'ana@gmail.com', p_role: 'admin', p_full_name: 'Ana' });
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'create_team_invitation', { p_email: 'ana@gmail.com', p_role: 'admin', p_full_name: null });
  });

  it('resend, cancel, setRole and remove call their functions', async () => {
    mockRpc.mockResolvedValue({ data: 'x', error: null });
    await teamService.resend('i1');
    await teamService.cancel('i1');
    await teamService.setRole('u1', 'marketing', 'motivo');
    await teamService.remove('u1', 'motivo');
    expect(mockRpc.mock.calls).toEqual([
      ['resend_team_invitation', { p_id: 'i1' }],
      ['cancel_team_invitation', { p_id: 'i1' }],
      ['set_team_member_role', { p_user: 'u1', p_role: 'marketing', p_reason: 'motivo' }],
      ['remove_team_member', { p_user: 'u1', p_reason: 'motivo' }],
    ]);
  });

  it('throws the function message with its team_* code, as a 400', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'No puedes cambiar tu propio acceso.', details: 'team_self' },
    });
    const err = await teamService.remove('u1', 'motivo').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ message: 'No puedes cambiar tu propio acceso.', code: 'team_self', statusCode: 400 });
  });

  it('says so when the database does not have the function yet', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    await expect(teamService.list()).rejects.toMatchObject({ code: 'RPC_MISSING' });
  });

  it('accept passes the token only when there is one and parses the answer', async () => {
    mockRpc.mockResolvedValue({ data: { result: 'accepted', role: 'marketing' }, error: null });
    await expect(teamService.accept('t'.repeat(64))).resolves.toEqual({ result: 'accepted', role: 'marketing', emailMasked: null });
    await teamService.accept();
    expect(mockRpc.mock.calls).toEqual([
      ['accept_team_invitation', { p_token: 't'.repeat(64) }],
      ['accept_team_invitation', {}],
    ]);
  });

  it('getInvitation reads the public page', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'expired' }, error: null });
    await expect(teamService.getInvitation('abc')).resolves.toEqual({ status: 'expired' });
    expect(mockRpc).toHaveBeenCalledWith('get_team_invitation', { p_token: 'abc' });
  });
});

describe('teamService invitation codes', () => {
  const TOKEN = 'a'.repeat(64);

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('requestInvitationCode asks the function to send a code', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { result: 'sent', account_exists: true, expires_in_s: 600, invitee_name: 'Nina' },
      error: null,
    });
    await expect(teamService.requestInvitationCode(TOKEN)).resolves.toEqual({
      accountExists: true,
      expiresInS: 600,
      inviteeName: 'Nina',
    });
    expect(mockInvoke).toHaveBeenCalledWith('team-invitation-code', { body: { action: 'send', token: TOKEN } });
  });

  it('throws a refusal with its Spanish message and the seconds to wait', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'cooldown', retry_after_s: 42 }, error: null });
    const err = await teamService.requestInvitationCode(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      message: 'Espera 42 segundos para pedir otro código.',
      code: 'invitation_cooldown',
      statusCode: 400,
      details: { result: 'cooldown', retryAfterS: 42 },
    });
  });

  it('says the mail could not go out', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'send_failed' }, error: null });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({
      message: 'No pudimos mandar el correo. Intenta de nuevo en un rato.',
      code: 'invitation_send_failed',
    });
  });

  // What rateLimitResponse (supabase/functions/_shared/rate-limiter.ts) sends.
  const limited = (retryAfterSec: number, header = true) =>
    new FunctionsHttpError(
      new Response(JSON.stringify({ error: 'Too many requests. Try again later.', retryAfterSec }), {
        status: 429,
        headers: header
          ? { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSec) }
          : { 'Content-Type': 'application/json' },
      }),
    );

  it('reads a 429 as too many attempts from this connection, with the wait from Retry-After', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: limited(1800) });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({
      message: 'Hubo demasiados intentos desde esta conexión. Vuelve a intentarlo en 30 minutos.',
      code: 'invitation_rate_limited',
      statusCode: 400,
      details: { result: 'rate_limited', retryAfterS: 1800 },
    });
  });

  it('reads the wait from the body when the header cannot be read', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: limited(61, false) });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123' }),
    ).rejects.toMatchObject({
      message: 'Hubo demasiados intentos desde esta conexión. Vuelve a intentarlo en 2 minutos.',
      details: { result: 'rate_limited', retryAfterS: 61 },
    });
  });

  it('falls back to a plain text when a 429 says nothing about the wait', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: new FunctionsHttpError(new Response('{}', { status: 429 })) });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({
      message: 'Hubo demasiados intentos desde esta conexión. Espera un rato y vuelve a intentarlo.',
      code: 'invitation_rate_limited',
      details: { retryAfterS: null },
    });
  });

  it('says there is no connection when the request never reached the function', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: new FunctionsFetchError(new TypeError('Failed to fetch')) });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({
      message: 'Sin conexión a internet. Revisa tu conexión y vuelve a intentarlo.',
      code: 'invitation_network',
      statusCode: 400,
    });
    // Recognized by name too, in case two copies of supabase-js end up in a bundle.
    mockInvoke.mockResolvedValueOnce({ data: null, error: { name: 'FunctionsFetchError', context: new TypeError('x') } });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({ code: 'invitation_network' });
  });

  it('reads any other failed call as a generic error', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: new FunctionsHttpError(new Response('{"error":"internal"}', { status: 500 })),
    });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({
      message: 'Algo salió mal. Intenta de nuevo.',
      code: 'invitation_error',
      statusCode: 400,
    });
    mockInvoke.mockResolvedValueOnce({ data: null, error: new FunctionsRelayError(new Response('', { status: 502 })) });
    await expect(teamService.requestInvitationCode(TOKEN)).rejects.toMatchObject({ code: 'invitation_error' });
  });

  it('acceptInvitationWithCode sends code, password and name, and answers the address and role', async () => {
    mockInvoke.mockResolvedValueOnce({
      data: { result: 'accepted', email: 'info@bacoagency.com', role: 'marketing' },
      error: null,
    });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: ' 048213 ', password: 'secreta123', fullName: ' Nina ' }),
    ).resolves.toEqual({ email: 'info@bacoagency.com', role: 'marketing' });
    expect(mockInvoke).toHaveBeenCalledWith('team-invitation-code', {
      body: { action: 'verify', token: TOKEN, code: '048213', password: 'secreta123', full_name: 'Nina' },
    });
  });

  it('leaves a blank name out', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'accepted', email: 'a@b.co', role: 'admin' }, error: null });
    await teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123', fullName: '  ' });
    const body = mockInvoke.mock.lastCall?.[1]?.body;
    expect(body).toMatchObject({ action: 'verify', code: '048213' });
    expect(body).not.toHaveProperty('full_name');
  });

  it('says how many attempts are left on a wrong code', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'wrong_code', attempts_left: 2 }, error: null });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '000000', password: 'secreta123' }),
    ).rejects.toMatchObject({ message: 'El código no es correcto. Te quedan 2 intentos.', code: 'invitation_wrong_code' });
  });

  it('passes on the refusals of the SQL functions', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'needs_google' }, error: null });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123' }),
    ).rejects.toMatchObject({ code: 'invitation_needs_google', statusCode: 400 });
  });

  it('treats an accepted answer without a panel role as a failure', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'accepted', email: 'a@b.co', role: 'customer' }, error: null });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123' }),
    ).rejects.toMatchObject({ code: 'invitation_try_again' });
  });

  it('treats an accepted answer without the address as a failure', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { result: 'accepted', role: 'admin' }, error: null });
    await expect(
      teamService.acceptInvitationWithCode({ token: TOKEN, code: '048213', password: 'secreta123' }),
    ).rejects.toMatchObject({ code: 'invitation_try_again' });
  });
});
