import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// uploadMemberLicense sends the file to the storage-upload Edge Function and
// then points fleet_members.license_doc_path at it. The EF refuses to replace
// anything under fleet-docs/ (supabase/functions/_shared/fleet-docs.ts), so
// each upload has to land on a name of its own.
const invoke = vi.fn();
const eq = vi.fn();
const update = vi.fn();
const from = vi.fn();

vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from, functions: { invoke } }),
}));

// Import after the mock is set up.
import { fleetService } from '../fleet.service';

const CORP = '00000000-0000-4000-8000-0000000000c1';
const MEMBER = '00000000-0000-4000-8000-000000000201';

function upload() {
  return fleetService.uploadMemberLicense({
    fleet_member_id: MEMBER,
    corporate_account_id: CORP,
    file: new Blob(['licence scan'], { type: 'image/jpeg' }),
    file_name: 'licencia.jpg',
    mime_type: 'image/jpeg',
  });
}

/** The multipart form of the n-th call to storage-upload. */
function sentForm(n = 0): FormData {
  const [name, options] = invoke.mock.calls[n] as [string, { body: FormData }];
  expect(name).toBe('storage-upload');
  return options.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
  invoke.mockResolvedValue({ data: { ok: true }, error: null });
  eq.mockResolvedValue({ error: null });
  update.mockReturnValue({ eq });
  from.mockReturnValue({ update });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fleetService.uploadMemberLicense', () => {
  it('never asks storage-upload to replace an existing file', async () => {
    await upload();
    expect(sentForm().get('upsert')).toBe('false');
  });

  it('gives every upload a name of its own inside the member folder', async () => {
    const first = await upload();
    vi.setSystemTime(new Date('2026-09-27T12:00:05.000Z'));
    const second = await upload();

    expect(first.storage_path).toBe(`fleet-docs/${CORP}/${MEMBER}/1790510400000-licencia.jpg`);
    expect(second.storage_path).toBe(`fleet-docs/${CORP}/${MEMBER}/1790510405000-licencia.jpg`);
    expect(sentForm(0).get('path')).toBe(first.storage_path);
    expect(sentForm(1).get('path')).toBe(second.storage_path);
  });

  it('points license_doc_path at the file it just uploaded', async () => {
    const { storage_path } = await upload();
    expect(from).toHaveBeenCalledWith('fleet_members');
    expect(update).toHaveBeenCalledWith({ license_doc_path: storage_path });
    expect(eq).toHaveBeenCalledWith('id', MEMBER);
  });

  it('leaves license_doc_path alone when storage-upload refuses the file', async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: new Error('Edge Function returned a non-2xx status code'),
    });
    await expect(upload()).rejects.toThrow('License upload failed');
    expect(update).not.toHaveBeenCalled();
  });
});
