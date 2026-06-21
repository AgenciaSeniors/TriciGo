import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

// ============================================================
// process-sms-dlr — Receives delivery receipt webhooks from
// D7 Networks and upserts into the sms_deliveries table.
//
// D7 doesn't sign requests, so we use a shared secret in the
// query string: D7 dashboard must be configured to POST to
//   https://<project>.supabase.co/functions/v1/process-sms-dlr?secret=<value>
// Set D7_WEBHOOK_SECRET in Supabase secrets to <value>.
//
// (D7 also supports a "Report URL Secret" field that sends as
// X-Webhook-Secret header — see future TODO to also verify it.)
//
// D7 sends form-data by default per docs; JSON also handled.
// Payload fields: request_id, msg_id, recipient, originator, status, tag.
// Status values: delivered, sent, scheduled, un_delivered.
// Endpoint must return 200 OK to acknowledge.
//
// This function is configured with verify_jwt:false (Supabase dashboard
// + supabase/config.toml). Auth is via the shared secret only.
// ============================================================

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // ── Shared-secret auth ──
  const url = new URL(req.url);
  const incomingSecret = url.searchParams.get('secret');
  const expectedSecret = Deno.env.get('D7_WEBHOOK_SECRET');
  if (!expectedSecret) {
    console.error('[process-sms-dlr] D7_WEBHOOK_SECRET not configured');
    return new Response('Server not configured', { status: 503 });
  }
  if (incomingSecret !== expectedSecret) {
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    console.warn('[process-sms-dlr] Invalid secret from', ip);
    return new Response('Unauthorized', { status: 401 });
  }

  // ── Parse payload ──
  const contentType = req.headers.get('content-type') || '';
  let payload: Record<string, unknown> = {};
  try {
    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        payload[k] = typeof v === 'string' ? v : '';
      }
    }
  } catch (e) {
    console.error('[process-sms-dlr] Failed to parse payload:', e);
    return new Response('Bad payload', { status: 400 });
  }

  const requestId = String(payload.request_id || '').trim();
  const rawStatus = String(payload.status || '').trim();
  if (!requestId || !rawStatus) {
    console.warn('[process-sms-dlr] Missing request_id or status:', payload);
    return new Response('Bad payload', { status: 400 });
  }

  // Normalize status to our enum (CHECK constraint values in sms_deliveries)
  const knownStatuses = new Set([
    'queued', 'sent', 'scheduled', 'delivered',
    'un_delivered', 'expired', 'failed', 'rejected',
  ]);
  const status = knownStatuses.has(rawStatus) ? rawStatus : 'unknown';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const nowIso = new Date().toISOString();
  const upsertRow: Record<string, unknown> = {
    request_id: requestId,
    recipient: String(payload.recipient || ''),
    originator: payload.originator ? String(payload.originator) : null,
    msg_id: payload.msg_id ? String(payload.msg_id) : null,
    tag: payload.tag ? String(payload.tag) : null,
    provider: 'd7',
    status,
    last_event_at: nowIso,
    raw_dlr: payload,
  };
  if (status === 'delivered') {
    upsertRow.delivered_at = nowIso;
  }

  // Upsert by request_id. DLR may arrive before send-sms-otp inserted (race),
  // or after (normal path). Either way we capture the latest state.
  const { error } = await supabase
    .from('sms_deliveries')
    .upsert(upsertRow, { onConflict: 'request_id' });

  if (error) {
    console.error('[process-sms-dlr] DB upsert error:', error, 'payload:', payload);
    return new Response('DB error', { status: 500 });
  }

  console.log(`[process-sms-dlr] ${requestId} -> status=${status}`);
  // D7 expects 200 OK to acknowledge receipt.
  return new Response('OK', { status: 200 });
});
