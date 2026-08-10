// ============================================================
// storage-upload
//
// Generic AUTHENTICATED upload to Supabase Storage using the SERVICE-ROLE
// key. Exists because the Storage service rejects the mobile/web session's
// user JWT (treats the request as `anon`) since the publishable-key
// migration, so `authenticated`-only Storage RLS INSERT policies fail with
// "new row violates row-level security policy" even though PostgREST + gotrue
// validate the same token fine. (Same root cause + fix pattern as
// upload-delivery-photo — generalized to the remaining buckets.)
//
// This function authenticates the caller via gotrue (auth.getUser), then
// enforces a STRICT per-bucket authorization that mirrors each bucket's RLS
// WITH CHECK, then uploads with the service-role client (bypassing RLS).
// It does NOT write any DB row: the client still does its own DB writes via
// PostgREST (which validates the JWT fine) and builds public URLs locally
// with getPublicUrl. So the contract for callers is unchanged — only the
// Storage write moves server-side.
//
// SECURITY: this function holds service-role power over multiple buckets, so
// the bucket allowlist + per-bucket path authorization below are the only
// thing standing between a logged-in user and writing to someone else's
// folder. Any bucket not in the allowlist is rejected. Each branch must
// replicate the intent of that bucket's RLS WITH CHECK and validate the
// ACTUAL path being uploaded (never trust a declared "intent").
//
// verify_jwt = false at the gateway (like delete-account / upload-delivery-photo):
// we do our OWN Bearer-token auth inside via auth.getUser.
//
// Request: multipart/form-data { file, bucket, path, upsert?, contentType? }
// Returns: { ok: true } | { error } with 4xx/5xx.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB — generous cap for ID/vehicle/avatar photos.

// Typed failure that carries an HTTP status + a diagnosable code/reason.
// WHY: the authz helpers used to `const { data } = await admin.from(...)` and
// ignore the query `error`, so a transient DB/connection blip returned
// data=undefined → authorized=false → a misleading `403 forbidden`,
// indistinguishable from a genuine authorization denial. Throwing this instead
// lets the outer catch surface `503 db_error` (retryable infra) vs a real
// `403 forbidden`. Still fail-closed: no upload happens on any error path.
class UploadError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(code);
    this.name = 'UploadError';
  }
}

// Per-bucket allowed MIME types. The caller-supplied content-type is stored
// verbatim and these buckets are PUBLIC → without a whitelist an attacker could
// upload text/html or image/svg+xml and have it served as active content.
// Whitelist raster images (+ PDF for documents); covers every type the current
// uploaders send (image/jpeg|png|webp|heic, image/{ext} for disputes, pdf docs).
const ALLOWED_MIME: Record<string, RegExp> = {
  'avatars': /^image\/(jpe?g|png|webp|heic|heif)$/i,
  'driver-documents': /^(image\/(jpe?g|png|webp|heic|heif)|application\/pdf)$/i,
  'dispute-evidence': /^image\/(jpe?g|png|webp|heic|heif|gif)$/i,
  // Deliberately narrower than the others, and aligned EXACTLY with the
  // bucket's own allowed_mime_types (00562). Letting heic through here would
  // pass this check and then fail at the Storage layer, which reads as a
  // mysterious upload failure rather than an unsupported format. The panel
  // re-encodes to JPEG before uploading anyway.
  'partner-photos': /^image\/(jpe?g|png|webp)$/i,
};

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// Split a storage key into NON-EMPTY segments, rejecting traversal / absolute
// paths. Returns null if the path is unsafe or empty.
function safeSegments(path: string): string[] | null {
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) return null;
  if (path.includes('%') || path.includes('\0')) return null; // no percent-encoding / null bytes
  const segs = path.split('/');
  if (segs.some((s) => s.trim() === '')) return null; // no empty / whitespace-only segments
  if (segs.length < 1) return null;
  return segs;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method_not_allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return jsonResponse(req, { error: 'misconfigured' }, 500);
  }

  // ─── 1. Auth: verify the Bearer token belongs to a real user ───
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(req, { error: 'unauthorized' }, 401);
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse(req, { error: 'unauthorized' }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ─── 2. Parse the multipart form ───
    // Reject oversized bodies BEFORE buffering the whole payload into memory
    // (req.formData() buffers everything). Content-Length can be omitted/spoofed,
    // so we ALSO re-check file.size after parsing.
    const contentLength = Number(req.headers.get('Content-Length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      return jsonResponse(req, { error: 'file_too_large' }, 413);
    }

    const form = await req.formData();
    const file = form.get('file');
    const bucket = String(form.get('bucket') ?? '');
    const path = String(form.get('path') ?? '');
    const upsert = String(form.get('upsert') ?? 'false') === 'true';
    const contentType =
      String(form.get('contentType') ?? '') ||
      (file instanceof File ? file.type : '') ||
      'application/octet-stream';

    if (!(file instanceof File)) {
      return jsonResponse(req, { error: 'missing_file' }, 400);
    }
    if (!bucket) {
      return jsonResponse(req, { error: 'missing_bucket' }, 400);
    }
    const segs = safeSegments(path);
    if (!segs) {
      return jsonResponse(req, { error: 'invalid_path' }, 400);
    }
    if ((file.size ?? 0) > MAX_BYTES) {
      return jsonResponse(req, { error: 'file_too_large' }, 413);
    }

    // ─── 3. Per-bucket authorization (mirrors each bucket's RLS WITH CHECK) ───
    const isAdmin = async (): Promise<boolean> => {
      const { data, error } = await admin.from('users').select('role').eq('id', user.id).maybeSingle();
      if (error) throw new UploadError(503, 'db_error', error.message);
      return !!data && ['admin', 'super_admin'].includes(data.role as string);
    };
    // The caller owns driverId iff it's their own driver_profiles row.
    const ownsDriverProfile = async (driverId: string): Promise<boolean> => {
      if (!driverId) return false;
      const { data, error } = await admin
        .from('driver_profiles')
        .select('id')
        .eq('id', driverId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw new UploadError(503, 'db_error', error.message);
      return !!data?.id;
    };
    // Corporate fleet license uploads (A6-01): the member must belong to a
    // fleet of the corporate account named in the path, and the caller must
    // administer that account (creator or active corp admin) — or be a
    // platform admin.
    const canManageFleetMemberDoc = async (corpId: string, memberId: string): Promise<boolean> => {
      if (!corpId || !memberId) return false;
      const { data: member, error: memberErr } = await admin
        .from('fleet_members')
        .select('id, fleet:driver_fleets!fleet_id(corporate_account_id)')
        .eq('id', memberId)
        .maybeSingle();
      if (memberErr) throw new UploadError(503, 'db_error', memberErr.message);
      const fleet = member?.fleet as
        | { corporate_account_id?: string }
        | { corporate_account_id?: string }[]
        | null
        | undefined;
      const memberCorp = Array.isArray(fleet)
        ? fleet[0]?.corporate_account_id
        : fleet?.corporate_account_id;
      if (!memberCorp || memberCorp !== corpId) return false;
      if (await isAdmin()) return true;
      const { data: corp, error: corpErr } = await admin
        .from('corporate_accounts')
        .select('created_by')
        .eq('id', corpId)
        .maybeSingle();
      if (corpErr) throw new UploadError(503, 'db_error', corpErr.message);
      if (corp?.created_by === user.id) return true;
      const { data: emp, error: empErr } = await admin
        .from('corporate_employees')
        .select('id')
        .eq('corporate_account_id', corpId)
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .eq('is_active', true)
        .maybeSingle();
      if (empErr) throw new UploadError(503, 'db_error', empErr.message);
      return !!emp?.id;
    };

    let authorized = false;

    if (bucket === 'avatars') {
      // path: {userId}/avatar.jpg  — RLS: foldername[1] = auth.uid()
      authorized = segs.length >= 2 && segs[0] === user.id;
    } else if (bucket === 'driver-documents') {
      // driver-docs/{driverId}/{docType}/{file}  OR
      // selfie-checks/{driverId}/{checkId}/{file}
      // RLS only ever covered 'driver-docs'; the EF also allows 'selfie-checks'
      // (closing the long-standing gap where selfie uploads had no INSERT policy).
      if ((segs[0] === 'driver-docs' || segs[0] === 'selfie-checks') && segs.length >= 3) {
        authorized = (await ownsDriverProfile(segs[1])) || (await isAdmin());
      } else if (segs[0] === 'fleet-docs' && segs.length >= 4) {
        // fleet-docs/{corporateAccountId}/{fleetMemberId}/{file} — corporate
        // fleet member license uploads (fleet.service.uploadMemberLicense).
        authorized = await canManageFleetMemberDoc(segs[1], segs[2]);
      }
    } else if (bucket === 'dispute-evidence') {
      // disputes/{rideId}/{userId}/{file} — uploader's own folder + party to ride.
      if (segs[0] === 'disputes' && segs.length >= 4 && segs[2] === user.id) {
        const { data: ride, error: rideErr } = await admin
          .from('rides')
          .select('customer_id, driver_id')
          .eq('id', segs[1])
          .maybeSingle();
        if (rideErr) throw new UploadError(503, 'db_error', rideErr.message);
        if (ride) {
          const isCustomer = ride.customer_id === user.id;
          let isDriver = false;
          if (!isCustomer && ride.driver_id) {
            const { data: dp, error: dpErr } = await admin
              .from('driver_profiles')
              .select('id')
              .eq('user_id', user.id)
              .maybeSingle();
            if (dpErr) throw new UploadError(503, 'db_error', dpErr.message);
            isDriver = !!dp?.id && ride.driver_id === dp.id;
          }
          authorized = isCustomer || isDriver || (await isAdmin());
        }
      }
    } else if (bucket === 'partner-photos') {
      // places/{placeId}/{file} — admins only (00562).
      //
      // Unlike every other bucket here there is no per-row owner to mirror: a
      // partner place belongs to the platform, not to a user, so the role IS
      // the authorization. The `places/` prefix is still required so this
      // branch can never be widened into a write primitive over the bucket
      // root by a caller that just passes a bare filename.
      authorized = segs[0] === 'places' && segs.length >= 3 && (await isAdmin());
    } else {
      // Bucket not in the allowlist — never let this become a general write primitive.
      return jsonResponse(req, { error: 'bucket_not_allowed' }, 403);
    }

    if (!authorized) {
      return jsonResponse(req, { error: 'forbidden' }, 403);
    }

    // Content-type whitelist (anti stored-XSS on the public buckets). Checked
    // after authz so we don't reveal anything to unauthorized callers.
    const mimePattern = ALLOWED_MIME[bucket];
    if (mimePattern && !mimePattern.test(contentType)) {
      return jsonResponse(req, { error: 'unsupported_media_type' }, 415);
    }

    // ─── 4. Upload via service-role (bypasses Storage RLS) ───
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await admin.storage.from(bucket).upload(path, bytes, {
      contentType,
      upsert,
    });
    if (uploadErr) {
      const status = (uploadErr as { statusCode?: number | string }).statusCode;
      throw new UploadError(Number(status) || 502, 'upload_failed', uploadErr.message);
    }

    return jsonResponse(req, { ok: true }, 200);
  } catch (e) {
    // Surface a diagnosable code + reason (DB blip vs storage failure) instead of
    // masking everything as a generic `upload_failed`. A genuine authz denial does
    // NOT reach here — it returns a bare 403 above — so no authz info is leaked.
    if (e instanceof UploadError) {
      console.error(`[storage-upload] ${e.code}:`, e.detail ?? '');
      return jsonResponse(req, { error: e.code, reason: e.detail }, e.status);
    }
    const msg = e instanceof Error ? e.message : 'unknown_error';
    console.error('[storage-upload] unexpected:', msg);
    return jsonResponse(req, { error: 'unknown_error', reason: msg }, 500);
  }
});
