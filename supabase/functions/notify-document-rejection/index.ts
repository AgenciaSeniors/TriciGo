// ============================================================
// TriciGo — notify-document-rejection edge function
//
// Invoked from the admin app (packages/api adminService.verifyDocument)
// right after a single driver document is rejected from /drivers/[id].
// The admin client cannot call send-email directly because send-email
// requires the SERVICE_ROLE key exactly (BUG-191 / 2026-05-12
// hardening) — so this EF runs server-side, gates the caller on
// admin/super_admin role (or service_role for triggers/cron), and
// invokes send-email with the SERVICE_ROLE secret it holds in env.
//
// Auth pattern mirrors send-bulk-email/index.ts (the canonical
// admin-gated EF).
//
// Body:
//   { documentId: string, reasonCodes?: string[], note?: string }
//
// Response:
//   200 { sent: true }
//   200 { sent: false, reason: 'no_real_email' }   // phone-OTP placeholder
//   200 { sent: false, reason: 'document_missing' }
//   401 / 403 / 400 / 500 as appropriate
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import {
  DOC_REJECTION_PRESETS,
  DOC_TYPE_LABELS_ES,
  labelForCode,
} from '../_shared/driverDocRejectionPresets.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
  };
}

interface NotifyBody {
  documentId: string;
  reasonCodes?: string[];
  note?: string;
}

// Mirrors packages/utils/src/validation.ts PLACEHOLDER_EMAIL_RE.
// Phone-OTP signups get a synthetic phone_<digits>@tricigo.app
// placeholder; never email it.
const PLACEHOLDER_EMAIL_RE = /^phone_\d+@tricigo\.app$/i;
function realEmail(email?: string | null): string | null {
  const e = email?.trim();
  if (!e) return null;
  if (PLACEHOLDER_EMAIL_RE.test(e)) return null;
  return e;
}

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceRoleKey || !supabaseUrl) {
      return jsonResponse({ error: 'server_misconfigured' }, 500, corsHeaders);
    }

    // ── Auth gate: service_role (DB triggers / cron) OR admin/super_admin JWT.
    const apiKey = req.headers.get('apikey') ?? '';
    const isInternalCall = apiKey === serviceRoleKey;

    if (!isInternalCall) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'missing_authorization' }, 401, corsHeaders);
      }
      const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
        authHeader.replace(/^Bearer\s+/i, ''),
      );
      if (authError || !user) {
        return jsonResponse({ error: 'invalid_token' }, 401, corsHeaders);
      }
      const { data: roleRow } = await supabaseAuth
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();
      if (
        !roleRow ||
        !['admin', 'super_admin'].includes(roleRow.role as string)
      ) {
        return jsonResponse(
          { error: 'forbidden_admin_role_required' },
          403,
          corsHeaders,
        );
      }
    }

    // ── Parse body.
    let body: NotifyBody;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, corsHeaders);
    }
    const { documentId, reasonCodes, note } = body;
    if (!documentId || typeof documentId !== 'string') {
      return jsonResponse({ error: 'missing_document_id' }, 400, corsHeaders);
    }

    // ── Resolve driver + email.
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: doc, error: docErr } = await supabase
      .from('driver_documents')
      .select('document_type, driver_profiles!inner(user_id, users!inner(full_name, email))')
      .eq('id', documentId)
      .single();
    if (docErr || !doc) {
      return jsonResponse({ sent: false, reason: 'document_missing' }, 200, corsHeaders);
    }

    // The nested joins come back loosely typed.
    type ProfileShape = { user_id: string; users: { full_name: string | null; email: string | null } };
    const profile = doc.driver_profiles as unknown as ProfileShape;
    const fullName = profile?.users?.full_name ?? '';
    const email = realEmail(profile?.users?.email);
    if (!email) {
      return jsonResponse({ sent: false, reason: 'no_real_email' }, 200, corsHeaders);
    }

    const documentType = doc.document_type as keyof typeof DOC_TYPE_LABELS_ES;
    const documentLabel = DOC_TYPE_LABELS_ES[documentType] ?? 'tu documento';

    // Localize codes for the email. Drop any codes that don't match
    // a preset (defensive — the UI should never send those).
    const reasonLabels: string[] = (reasonCodes ?? [])
      .map(labelForCode)
      .filter((l): l is string => !!l && l.length > 0);

    // ── Invoke send-email with the service-role secret we hold.
    const sendEmailRes = await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({
        template: 'driver_document_rejected',
        data: {
          full_name: fullName,
          document_label: documentLabel,
          reason_labels: reasonLabels,
          note: note ?? '',
        },
        recipient_email: email,
        locale: 'es',
      }),
    });

    if (!sendEmailRes.ok) {
      const errText = await sendEmailRes.text().catch(() => '');
      console.error('[notify-document-rejection] send-email failed', sendEmailRes.status, errText);
      return jsonResponse(
        { sent: false, reason: 'send_email_failed', status: sendEmailRes.status },
        200,
        corsHeaders,
      );
    }

    // Touch the dataset import so a future tree-shake doesn't dead-code it.
    // (DOC_REJECTION_PRESETS is exported in case other EFs reuse it later.)
    void DOC_REJECTION_PRESETS;

    return jsonResponse({ sent: true }, 200, corsHeaders);
  } catch (err) {
    console.error('[notify-document-rejection] unexpected error', err);
    return jsonResponse(
      { error: 'unexpected_error', message: err instanceof Error ? err.message : String(err) },
      500,
      corsHeaders,
    );
  }
});
