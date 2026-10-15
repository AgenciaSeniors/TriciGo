// ============================================================
// Account deletion — the Storage step.
//
// Removes the files of an account that is being deleted: the avatar, and for a
// driver the documents and the selfie checks. The driver's files live in the
// private driver-documents bucket under the DRIVER PROFILE id, not the user id:
//   driver-docs/{driver_profiles.id}/{document_type}/{file}   (uploadDocument)
//   selfie-checks/{driver_profiles.id}/{check_id}/{file}       (uploadSelfieCheck)
// Until 2026-10 the cleanup listed {user_id}/ and never removed a thing: 135
// files of 22 deleted drivers were left behind. The driver_profiles row goes
// away with the auth user (ON DELETE CASCADE), so the caller reads its id
// before deleting anything.
//
// fleet-docs/ (licenses a fleet owner uploads for its members) belongs to the
// fleet, not to the driver whose account is deleted, and is left alone.
//
// Best effort: nothing here throws. Every Storage error ends up in `errors`, the
// caller logs them with logAccountStorageCleanup, and the deletion goes on.
//
// Pure module: no remote imports, no Deno, so packages/api's vitest runs it.
// ============================================================

export interface StorageErrorLike {
  message?: string;
}

/** One entry of a Storage listing. Folders come back with a null id. */
export interface StorageListEntry {
  name: string;
  id: string | null;
}

export interface StorageListOptions {
  limit: number;
  offset: number;
  sortBy: { column: string; order: string };
}

/** The part of supabase-js's StorageFileApi this module uses. */
export interface StorageBucketApi {
  list(
    path: string,
    options: StorageListOptions,
  ): PromiseLike<{ data: StorageListEntry[] | null; error: StorageErrorLike | null }>;
  remove(paths: string[]): PromiseLike<{ data: unknown[] | null; error: StorageErrorLike | null }>;
}

export interface StorageApi {
  from(bucket: string): StorageBucketApi;
}

export interface AccountStorageCleanup {
  avatarsRemoved: number;
  driverProfileId: string | null;
  documentsFound: number;
  documentsRemoved: number;
  errors: string[];
}

export const AVATARS_BUCKET = 'avatars';
export const DRIVER_DOCUMENTS_BUCKET = 'driver-documents';

// Storage lists 100 entries per call by default; a remove takes up to 1000 names.
const PAGE_SIZE = 100;
const REMOVE_BATCH = 100;
// Folder levels walked below a driver's prefix. Today every file sits one level
// down ({document_type}/ or {check_id}/).
const MAX_DEPTH = 3;
// Pages per folder (20,000 entries): a guard against a listing that never ends.
const MAX_PAGES = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folders that hold a driver's files in the driver-documents bucket. */
export function driverDocumentPrefixes(driverProfileId: string): string[] {
  return [`driver-docs/${driverProfileId}`, `selfie-checks/${driverProfileId}`];
}

/** Both apps write {user_id}/avatar.jpg; the other two names are older uploads. */
function avatarPaths(userId: string): string[] {
  return [`${userId}/avatar.jpg`, `${userId}/avatar.png`, `${userId}/avatar.webp`];
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && typeof (e as StorageErrorLike).message === 'string') {
    return (e as StorageErrorLike).message as string;
  }
  return String(e);
}

/** Every file under `prefix`, through its subfolders. Listing errors are reported, not thrown. */
async function listFilesUnder(
  bucket: StorageBucketApi,
  prefix: string,
): Promise<{ paths: string[]; errors: string[] }> {
  const paths = new Set<string>();
  const errors: string[] = [];

  const walk = async (folder: string, depth: number): Promise<void> => {
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) {
        errors.push(`list ${folder}: stopped after ${MAX_PAGES * PAGE_SIZE} entries`);
        return;
      }
      let entries: StorageListEntry[];
      try {
        const { data, error } = await bucket.list(folder, {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          sortBy: { column: 'name', order: 'asc' },
        });
        if (error) {
          errors.push(`list ${folder}: ${messageOf(error)}`);
          return;
        }
        entries = data ?? [];
      } catch (e) {
        errors.push(`list ${folder}: ${messageOf(e)}`);
        return;
      }
      for (const entry of entries) {
        const name = entry?.name;
        if (!name || name.includes('/')) continue;
        const path = `${folder}/${name}`;
        if (entry.id != null) {
          paths.add(path);
        } else if (depth < MAX_DEPTH) {
          await walk(path, depth + 1);
        } else {
          errors.push(`list ${path}: more than ${MAX_DEPTH} folder levels down, not listed`);
        }
      }
      if (entries.length < PAGE_SIZE) return;
    }
  };

  await walk(prefix, 0);
  return { paths: [...paths], errors };
}

/**
 * Removes `paths` in batches. A failed batch is reported and the next one still
 * runs. No call for an empty list: the API rejects a remove of zero names.
 */
async function removeFiles(
  bucket: StorageBucketApi,
  paths: string[],
): Promise<{ removed: number; errors: string[] }> {
  let removed = 0;
  const errors: string[] = [];
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH);
    try {
      const { data, error } = await bucket.remove(batch);
      if (error) errors.push(`remove ${batch.length} file(s): ${messageOf(error)}`);
      else removed += data?.length ?? 0;
    } catch (e) {
      errors.push(`remove ${batch.length} file(s): ${messageOf(e)}`);
    }
  }
  return { removed, errors };
}

async function removeAccountFiles(
  storage: StorageApi,
  account: { userId: string; driverProfileId: string | null },
  result: AccountStorageCleanup,
): Promise<void> {
  const avatars = await removeFiles(storage.from(AVATARS_BUCKET), avatarPaths(account.userId));
  result.avatarsRemoved = avatars.removed;
  result.errors.push(...avatars.errors.map((e) => `${AVATARS_BUCKET}/${account.userId}: ${e}`));

  const driverProfileId = account.driverProfileId;
  if (driverProfileId === null) return;
  // Anything but a uuid could turn the prefix into driver-docs/ itself and walk
  // every driver's files.
  if (!UUID_RE.test(driverProfileId)) {
    result.errors.push(
      `${DRIVER_DOCUMENTS_BUCKET}: driver profile id ${JSON.stringify(driverProfileId)} is not a uuid, nothing listed`,
    );
    return;
  }

  const bucket = storage.from(DRIVER_DOCUMENTS_BUCKET);
  for (const prefix of driverDocumentPrefixes(driverProfileId)) {
    const listing = await listFilesUnder(bucket, prefix);
    result.errors.push(...listing.errors.map((e) => `${DRIVER_DOCUMENTS_BUCKET}: ${e}`));
    result.documentsFound += listing.paths.length;
    const removal = await removeFiles(bucket, listing.paths);
    result.documentsRemoved += removal.removed;
    result.errors.push(...removal.errors.map((e) => `${DRIVER_DOCUMENTS_BUCKET}/${prefix}: ${e}`));
  }
}

/**
 * Removes the avatar of `userId` and, when `driverProfileId` is set, every file
 * under that driver's folders in driver-documents. Never throws.
 */
export async function cleanUpAccountStorage(
  storage: StorageApi,
  account: { userId: string; driverProfileId: string | null },
): Promise<AccountStorageCleanup> {
  const result: AccountStorageCleanup = {
    avatarsRemoved: 0,
    driverProfileId: account.driverProfileId,
    documentsFound: 0,
    documentsRemoved: 0,
    errors: [],
  };
  try {
    await removeAccountFiles(storage, account, result);
  } catch (e) {
    // A broken client (or a bug here) must not stop the deletion either.
    result.errors.push(`storage cleanup stopped: ${messageOf(e)}`);
  }
  return result;
}

/** One error line per Storage failure, plus a summary when there were driver documents. */
export function logAccountStorageCleanup(tag: string, userId: string, result: AccountStorageCleanup): void {
  const who = result.driverProfileId
    ? `user ${userId}, driver profile ${result.driverProfileId}`
    : `user ${userId}`;
  for (const error of result.errors) {
    console.error(`${tag} storage cleanup (${who}): ${error}`);
  }
  if (result.documentsFound > 0) {
    console.log(
      `${tag} removed ${result.documentsRemoved} of ${result.documentsFound} driver document file(s) (${who})`,
    );
  }
}
