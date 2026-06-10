// ============================================================
// upload-delivery-photo
//
// Authenticated edge function that uploads a delivery proof photo (pickup or
// delivery) to the `delivery-photos` Storage bucket using the SERVICE-ROLE
// key, then records the public URL on `delivery_details`.
//
// WHY a separate function (not a direct client → Storage upload):
// the Storage service rejects the mobile session's user JWT — it treats the
// request as `anon`, so the `authenticated`-only `delivery_photos_insert` RLS
// policy fails with "new row violates row-level security policy", even though
// PostgREST + gotrue validate the same token fine. (Authenticated client
// Storage uploads have been broken since the publishable-key migration; the
// path + policy are otherwise correct.) This function authenticates the caller
// via gotrue (auth.getUser), verifies the caller is the DRIVER of the ride,
// then uploads + records the URL with the service-role client (bypassing
// Storage RLS entirely).
//
// verify_jwt = false at the gateway (like delete-account): we do our OWN
// Bearer-token auth inside via auth.getUser, avoiding the gateway JWT path.
//
// Request: multipart/form-data with fields `file` (the JPEG), `ride_id`, and
// `phase` ('pickup' | 'delivery'). Sent by deliveryService.uploadDeliveryPhoto
// via supabase.functions.invoke (which attaches the session JWT).
// Returns: { ok: true, publicUrl } | { error } with 4xx/5xx.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

// PASS #3: size cap + MIME whitelist (parity with the storage-upload EF). The
// delivery-photos bucket is PUBLIC, so accepting arbitrary content-types (e.g.
// image/svg+xml / text/html) is a stored-XSS vector, and an unbounded body was
// buffered fully in Deno memory before storage.
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — generous for a compressed photo
const ALLOWED_MIME = /^image\/(jpe?g|png|webp|heic|heif)$/i;

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
    // Reject oversized bodies before buffering the whole thing in memory.
    const contentLength = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      return jsonResponse(req, { error: 'file_too_large' }, 413);
    }

    // ─── 2. Parse the multipart form ───
    const form = await req.formData();
    const file = form.get('file');
    const rideId = String(form.get('ride_id') ?? '');
    const phase = String(form.get('phase') ?? 'delivery');
    if (!(file instanceof File)) {
      return jsonResponse(req, { error: 'missing_file' }, 400);
    }
    // Size cap + MIME whitelist (see top-of-file note).
    if (typeof file.size === 'number' && file.size > MAX_BYTES) {
      return jsonResponse(req, { error: 'file_too_large' }, 413);
    }
    if (file.type && !ALLOWED_MIME.test(file.type)) {
      return jsonResponse(req, { error: 'invalid_file_type' }, 415);
    }
    if (!rideId) {
      return jsonResponse(req, { error: 'missing_ride_id' }, 400);
    }
    if (phase !== 'pickup' && phase !== 'delivery') {
      return jsonResponse(req, { error: 'invalid_phase' }, 400);
    }

    // ─── 3. Ownership: caller must be the DRIVER of the ride (or admin) ───
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('driver_id')
      .eq('id', rideId)
      .single();
    if (rideErr || !ride) {
      return jsonResponse(req, { error: 'ride_not_found' }, 404);
    }
    const { data: dp } = await admin
      .from('driver_profiles')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();
    const { data: roleRow } = await admin
      .from('users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    const isAdmin = !!roleRow && ['admin', 'super_admin'].includes(roleRow.role as string);
    const isDriverOfRide = !!dp?.id && ride.driver_id === dp.id;
    if (!isAdmin && !isDriverOfRide) {
      return jsonResponse(req, { error: 'forbidden_not_ride_driver' }, 403);
    }

    // ─── 4. Upload to delivery-photos via service-role (bypasses RLS) ───
    // Path contract: ride id is the FIRST folder segment (matches the
    // delivery_photos storage policy, and keeps the layout consistent).
    const fileName = `${phase}-${rideId}-${Date.now()}.jpg`;
    const storagePath = `${rideId}/${fileName}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await admin.storage
      .from('delivery-photos')
      .upload(storagePath, bytes, {
        contentType: file.type || 'image/jpeg',
        upsert: true,
      });
    if (uploadErr) {
      throw new Error(`upload_failed: ${uploadErr.message}`);
    }

    const { data: urlData } = admin.storage.from('delivery-photos').getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    // ─── 5. Record the URL on delivery_details (service-role) ───
    const column = phase === 'pickup' ? 'pickup_photo_url' : 'delivery_photo_url';
    const { error: updErr } = await admin
      .from('delivery_details')
      .update({ [column]: publicUrl })
      .eq('ride_id', rideId);
    if (updErr) {
      throw new Error(`update_failed: ${updErr.message}`);
    }

    return jsonResponse(req, { ok: true, publicUrl }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown_error';
    console.error('[upload-delivery-photo] failed:', msg);
    return jsonResponse(req, { error: 'upload_failed' }, 500);
  }
});
