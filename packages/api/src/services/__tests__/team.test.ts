import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ rpc: mockRpc }),
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
