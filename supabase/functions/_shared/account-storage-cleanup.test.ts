import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanUpAccountStorage,
  driverDocumentPrefixes,
  logAccountStorageCleanup,
  type StorageApi,
} from './account-storage-cleanup.ts';

// In-memory Storage that lists the way the Storage API does (checked against the
// live driver-documents bucket on 2026-10-14): one level per call, folders with
// id null and files with an id, sorted by name, paged by limit/offset. A remove
// takes 1 to 1000 names, like the API.
type Fault = { message: string } | 'throw' | 'endless';

function fakeStorage(seed: Record<string, string[]>) {
  const objects = new Map(Object.entries(seed).map(([bucket, keys]) => [bucket, new Set(keys)]));
  const calls: string[] = [];
  // Keyed by `${bucket}:${folder}` for list, by `${bucket}:${call number}` for remove.
  const listFaults = new Map<string, Fault>();
  const removeFaults = new Map<string, Fault>();
  const removeCalls = new Map<string, number>();

  const api: StorageApi = {
    from: (bucket) => ({
      list: async (path, options) => {
        calls.push(`${bucket} list ${path} offset=${options.offset}`);
        const fault = listFaults.get(`${bucket}:${path}`);
        if (fault === 'throw') throw new Error('socket hang up');
        if (fault === 'endless') {
          return {
            data: Array.from({ length: options.limit }, (_, i) => ({ name: `again-${i}.jpg`, id: `obj-${i}` })),
            error: null,
          };
        }
        if (fault) return { data: null, error: fault };
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const entries = new Map<string, boolean>();
        for (const key of objects.get(bucket) ?? []) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const name = rest.split('/')[0];
          if (!entries.has(name)) entries.set(name, !rest.includes('/'));
        }
        const page = [...entries.keys()]
          .sort()
          .map((name) => ({ name, id: entries.get(name) ? `obj-${name}` : null }));
        return { data: page.slice(options.offset, options.offset + options.limit), error: null };
      },
      remove: async (paths) => {
        const n = (removeCalls.get(bucket) ?? 0) + 1;
        removeCalls.set(bucket, n);
        calls.push(`${bucket} remove ${paths.length}`);
        const fault = removeFaults.get(`${bucket}:${n}`);
        if (fault === 'throw') throw new Error('socket hang up');
        if (fault && fault !== 'endless') return { data: null, error: fault };
        if (paths.length < 1 || paths.length > 1000) {
          return { data: null, error: { message: 'prefixes must have 1 to 1000 items' } };
        }
        const removed = paths.filter((p) => objects.get(bucket)?.delete(p));
        return { data: removed.map((name) => ({ name })), error: null };
      },
    }),
  };

  return {
    api,
    calls,
    listFaults,
    removeFaults,
    left: (bucket: string) => [...(objects.get(bucket) ?? [])].sort(),
  };
}

const DP = '7a1c2f30-1111-4222-8333-444455556666';
const OTHER_DP = '9b2d3e41-5555-4666-8777-888899990000';
const USER = '00000000-0000-4000-8000-0000000000c3';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('driverDocumentPrefixes', () => {
  it("names the driver's two folders in the driver-documents bucket", () => {
    expect(driverDocumentPrefixes(DP)).toEqual([`driver-docs/${DP}`, `selfie-checks/${DP}`]);
  });
});

describe('cleanUpAccountStorage', () => {
  it("removes every file under the driver's folders, and nothing outside them", async () => {
    const s = fakeStorage({
      'driver-documents': [
        `driver-docs/${DP}/national_id/1760000000000-carnet.jpg`,
        `driver-docs/${DP}/national_id/1760000000001-carnet.jpg`,
        `driver-docs/${DP}/vehicle_photo/1760000000002-moto.jpg`,
        `driver-docs/${DP}/stray.pdf`,
        `selfie-checks/${DP}/0c1d2e3f-0000-4000-8000-000000000001/selfie.jpg`,
        `driver-docs/${OTHER_DP}/national_id/1760000000003-carnet.jpg`,
        `selfie-checks/${OTHER_DP}/0c1d2e3f-0000-4000-8000-000000000002/selfie.jpg`,
        'fleet-docs/corp-1/member-1/1760000000004-license.pdf',
      ],
      avatars: [`${USER}/avatar.jpg`, 'someone-else/avatar.jpg'],
    });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.left('driver-documents')).toEqual([
      `driver-docs/${OTHER_DP}/national_id/1760000000003-carnet.jpg`,
      'fleet-docs/corp-1/member-1/1760000000004-license.pdf',
      `selfie-checks/${OTHER_DP}/0c1d2e3f-0000-4000-8000-000000000002/selfie.jpg`,
    ]);
    expect(s.left('avatars')).toEqual(['someone-else/avatar.jpg']);
    expect(result).toEqual({
      avatarsRemoved: 1,
      driverProfileId: DP,
      documentsFound: 5,
      documentsRemoved: 5,
      errors: [],
    });
  });

  it('pages through levels with more than one listing of folders and files', async () => {
    const keys = [
      ...Array.from({ length: 130 }, (_, i) => `driver-docs/${DP}/type_${String(i).padStart(3, '0')}/a.jpg`),
      ...Array.from({ length: 230 }, (_, i) => `driver-docs/${DP}/vehicle_photo/${1760000000000 + i}-moto.jpg`),
    ];
    const s = fakeStorage({ 'driver-documents': keys });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.left('driver-documents')).toEqual([]);
    expect(result.documentsFound).toBe(360);
    expect(result.documentsRemoved).toBe(360);
    expect(result.errors).toEqual([]);
  });

  it('removes more files than one remove call takes', async () => {
    const s = fakeStorage({
      'driver-documents': Array.from(
        { length: 1234 },
        (_, i) => `driver-docs/${DP}/vehicle_photo/${1760000000000 + i}-moto.jpg`,
      ),
    });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.left('driver-documents')).toEqual([]);
    expect(result.documentsRemoved).toBe(1234);
    expect(result.errors).toEqual([]);
  });

  it('does not call remove for a driver without files', async () => {
    const s = fakeStorage({ 'driver-documents': [`driver-docs/${OTHER_DP}/national_id/a.jpg`] });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.calls.filter((c) => c.startsWith('driver-documents remove'))).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.documentsFound).toBe(0);
  });

  it('does not touch the bucket for an account that never was a driver', async () => {
    const s = fakeStorage({ 'driver-documents': [`driver-docs/${OTHER_DP}/national_id/a.jpg`] });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: null });

    expect(s.calls.filter((c) => c.startsWith('driver-documents'))).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it.each(['', 'abc', '../x', `${DP}/..`, 'driver-docs'])(
    'lists nothing when the driver profile id is %j, so it can never walk every driver',
    async (badId) => {
      const s = fakeStorage({
        'driver-documents': [`driver-docs/${DP}/national_id/a.jpg`, `driver-docs/${OTHER_DP}/national_id/b.jpg`],
      });

      const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: badId });

      expect(s.calls.filter((c) => c.startsWith('driver-documents'))).toEqual([]);
      expect(s.left('driver-documents')).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('not a uuid');
    },
  );

  it('keeps going after a folder fails to list, and reports which one', async () => {
    const s = fakeStorage({
      'driver-documents': [
        `driver-docs/${DP}/national_id/a.jpg`,
        `driver-docs/${DP}/selfie/b.jpg`,
        `selfie-checks/${DP}/0c1d2e3f-0000-4000-8000-000000000001/c.jpg`,
      ],
    });
    s.listFaults.set(`driver-documents:driver-docs/${DP}/national_id`, { message: 'storage unavailable' });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.left('driver-documents')).toEqual([`driver-docs/${DP}/national_id/a.jpg`]);
    expect(result.documentsRemoved).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`driver-docs/${DP}/national_id`);
    expect(result.errors[0]).toContain('storage unavailable');
  });

  it('reports a listing that throws, and still clears the other folder', async () => {
    const s = fakeStorage({
      'driver-documents': [
        `driver-docs/${DP}/national_id/a.jpg`,
        `selfie-checks/${DP}/0c1d2e3f-0000-4000-8000-000000000001/c.jpg`,
      ],
    });
    s.listFaults.set(`driver-documents:selfie-checks/${DP}`, 'throw');

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.left('driver-documents')).toEqual([`selfie-checks/${DP}/0c1d2e3f-0000-4000-8000-000000000001/c.jpg`]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`selfie-checks/${DP}`);
    expect(result.errors[0]).toContain('socket hang up');
  });

  it.each([
    ['answers with an error', { message: 'storage unavailable' } as const, 'storage unavailable'],
    ['throws', 'throw' as const, 'socket hang up'],
  ])('keeps removing after a batch %s, and reports it', async (_case, fault, message) => {
    const s = fakeStorage({
      'driver-documents': Array.from({ length: 150 }, (_, i) => `driver-docs/${DP}/vehicle_photo/${1760000000000 + i}.jpg`),
    });
    s.removeFaults.set('driver-documents:1', fault);

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(result.documentsFound).toBe(150);
    expect(result.documentsRemoved).toBe(50);
    expect(s.left('driver-documents')).toHaveLength(100);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`driver-docs/${DP}`);
    expect(result.errors[0]).toContain(message);
  });

  it('reports a folder deeper than it walks instead of skipping it quietly', async () => {
    const s = fakeStorage({
      'driver-documents': [`driver-docs/${DP}/a/b/c/kept.jpg`, `driver-docs/${DP}/a/b/c/d/too-deep.jpg`],
    });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(s.left('driver-documents')).toEqual([`driver-docs/${DP}/a/b/c/d/too-deep.jpg`]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`driver-docs/${DP}/a/b/c/d`);
  });

  it('stops paging a folder whose listing never ends, and reports it', async () => {
    const s = fakeStorage({ 'driver-documents': [] });
    s.listFaults.set(`driver-documents:driver-docs/${DP}`, 'endless');

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: DP });

    expect(result.errors.some((e) => e.includes(`driver-docs/${DP}`) && e.includes('stopped'))).toBe(true);
  });

  it('never throws, even when the Storage client itself does', async () => {
    const broken: StorageApi = {
      from: () => {
        throw new TypeError('storage client unavailable');
      },
    };

    const result = await cleanUpAccountStorage(broken, { userId: USER, driverProfileId: DP });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('storage client unavailable');
  });

  it('reports a failed avatar removal', async () => {
    const s = fakeStorage({ avatars: [`${USER}/avatar.jpg`] });
    s.removeFaults.set('avatars:1', { message: 'storage unavailable' });

    const result = await cleanUpAccountStorage(s.api, { userId: USER, driverProfileId: null });

    expect(result.avatarsRemoved).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`avatars/${USER}`);
    expect(result.errors[0]).toContain('storage unavailable');
  });
});

describe('logAccountStorageCleanup', () => {
  it('logs each error with the user and the driver profile, and a summary of what it removed', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    logAccountStorageCleanup('[delete-account]', USER, {
      avatarsRemoved: 1,
      driverProfileId: DP,
      documentsFound: 3,
      documentsRemoved: 2,
      errors: ['driver-documents: list driver-docs/x/national_id: storage unavailable'],
    });

    expect(errors).toHaveBeenCalledTimes(1);
    const errorLine = errors.mock.calls[0].join(' ');
    expect(errorLine).toContain('[delete-account]');
    expect(errorLine).toContain(USER);
    expect(errorLine).toContain(DP);
    expect(errorLine).toContain('storage unavailable');
    const summary = info.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(summary).toContain('2 of 3');
    expect(summary).toContain(DP);
  });

  it('stays quiet for an account with nothing to remove and no errors', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    logAccountStorageCleanup('[delete-account]', USER, {
      avatarsRemoved: 0,
      driverProfileId: null,
      documentsFound: 0,
      documentsRemoved: 0,
      errors: [],
    });

    expect(errors).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
