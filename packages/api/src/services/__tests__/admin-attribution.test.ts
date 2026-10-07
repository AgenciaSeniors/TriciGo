import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// The admin panel used to pass the literal string 'admin' as the actor id.
// cms_content.updated_by, notification_log.sent_by and admin_actions.admin_id
// are uuid columns, so the CMS save failed with 22P02 and the push history row
// was never written. The services now take the actor from the session.

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

const getUser: Mock<() => Promise<{ data: { user: { id: string } | null } }>> = vi.fn();
const invoke: Mock<(...args: unknown[]) => Promise<{ data: unknown; error: unknown }>> = vi.fn();
const writes: Array<{ table: string; op: string; payload: unknown }> = [];
let updateRows: Array<{ slug: string }> = [{ slug: 'terms' }];

function from(table: string) {
  return {
    update(payload: unknown) {
      writes.push({ table, op: 'update', payload });
      const chain = {
        eq: () => chain,
        select: () => Promise.resolve({ data: updateRows, error: null }),
      };
      return chain;
    },
    insert(payload: unknown) {
      writes.push({ table, op: 'insert', payload });
      return Promise.resolve({ error: null });
    },
  };
}

const mockSupabase = {
  auth: { getUser },
  from: vi.fn(from),
  functions: { invoke },
};

vi.mock('../../client', () => ({ getSupabaseClient: () => mockSupabase }));

import { cmsService } from '../cms.service';
import { notificationService } from '../notification.service';

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  updateRows = [{ slug: 'terms' }];
  getUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
  invoke.mockResolvedValue({ data: { sent: 1, failed: 0 }, error: null });
});

describe('cmsService.updateContent', () => {
  it('records the signed-in admin as the editor and in the audit trail', async () => {
    await cmsService.updateContent('terms', { title_es: 'Términos' });

    const update = writes.find((w) => w.table === 'cms_content' && w.op === 'update');
    expect(update?.payload).toMatchObject({ title_es: 'Términos', updated_by: ADMIN_ID });
    const audit = writes.find((w) => w.table === 'admin_actions');
    expect(audit?.payload).toMatchObject({ admin_id: ADMIN_ID, action: 'update_cms_content', target_id: 'terms' });
  });

  it('refuses to save without a session', async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    await expect(cmsService.updateContent('terms', { title_es: 'x' })).rejects.toThrow();
    expect(writes).toHaveLength(0);
  });

  it('fails when no row was updated instead of reporting success', async () => {
    // RLS hides the row from a non-admin: PostgREST answers OK with 0 rows.
    updateRows = [];

    await expect(cmsService.updateContent('terms', { title_es: 'x' })).rejects.toThrow();
    expect(writes.find((w) => w.table === 'admin_actions')).toBeUndefined();
  });
});

describe('notificationService.sendAdminPush', () => {
  it('logs the push under the signed-in admin', async () => {
    await notificationService.sendAdminPush({ userId: 'u-1' }, { title: 'Hola', body: 'Prueba' });

    const log = writes.find((w) => w.table === 'notification_log');
    expect(log?.payload).toMatchObject({ sent_by: ADMIN_ID, target_type: 'user', target_user_id: 'u-1', sent_count: 1 });
  });

  it('sends nothing without a session', async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    await expect(
      notificationService.sendAdminPush({ userId: 'u-1' }, { title: 'Hola', body: 'Prueba' }),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe('notificationService.sendToUser', () => {
  // From the admin panel this used to call exp.host from the browser, which
  // the browser blocks: 1,106 driver-approval/document pushes were logged with
  // sent_count 0, 206 of them to drivers who had a push token.
  it('delivers through the send-push Edge Function, keeping the data payload', async () => {
    const res = await notificationService.sendToUser(
      'driver-1',
      'Cuenta aprobada',
      'Ya puedes recibir viajes',
      ADMIN_ID,
      { type: 'driver_status', status: 'approved' },
    );

    expect(invoke).toHaveBeenCalledWith('send-push', {
      body: {
        user_ids: ['driver-1'],
        title: 'Cuenta aprobada',
        body: 'Ya puedes recibir viajes',
        data: { type: 'driver_status', status: 'approved' },
      },
    });
    expect(res).toEqual({ successCount: 1, errorCount: 0 });
    const log = writes.find((w) => w.table === 'notification_log');
    expect(log?.payload).toMatchObject({ sent_by: ADMIN_ID, target_user_id: 'driver-1', sent_count: 1 });
  });

  it('does not write a history row with a sender that is not a user id', async () => {
    await notificationService.sendToUser('u-1', 'Disputa', 'Cambió', 'system');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(writes.find((w) => w.table === 'notification_log')).toBeUndefined();
  });

  it('surfaces a send-push failure', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('Forbidden') });

    await expect(notificationService.sendToUser('u-1', 'T', 'B', ADMIN_ID)).rejects.toThrow('Forbidden');
    expect(writes).toHaveLength(0);
  });
});
