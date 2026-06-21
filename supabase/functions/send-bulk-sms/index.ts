// ============================================================
// TriciGo — send-bulk-sms edge function
//
// Sends an SMS to many users at once via D7 Networks (sole SMS
// provider; Twilio removed 2026-06-07). Called from the admin
// /campaigns page when channel='sms' or 'both'. Non-blocking per-recipient.
//
// Throttled to ~10 SMS/sec. D7 credentials come from the D7_API_TOKEN
// env secret (via the shared _shared/d7.ts helper).
//
// BUG-179 fix: this EF previously had NO authentication. Any
// authenticated user could call it with arbitrary user_ids and
// custom body, draining our SMS quota and using us as a phishing
// channel against any user in the DB. Now requires admin role
// (or service_role for cron/automation).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { sendSmsViaD7 } from '../_shared/d7.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface BulkSmsRequest {
  user_ids: string[];
  body: string;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // ── Auth gate: service_role OR authenticated admin ──
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const apiKey = req.headers.get('apikey') ?? '';
    const isInternalCall = apiKey === serviceRoleKey;

    if (!isInternalCall) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
        authHeader.replace('Bearer ', ''),
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { data: roleRow } = await supabaseAuth.from('users').select('role').eq('id', user.id).single();
      if (!roleRow || !['admin', 'super_admin'].includes(roleRow.role as string)) {
        return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const body: BulkSmsRequest = await req.json();
    const { user_ids, body: smsBody } = body;

    if (!Array.isArray(user_ids) || user_ids.length === 0 || !smsBody) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_params' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Fetch phones
    const { data: users, error } = await supabase
      .from('users')
      .select('id, phone')
      .in('id', user_ids)
      .not('phone', 'is', null);
    if (error) throw error;

    const recipients = (users ?? []).filter((u) => u.phone && u.phone.startsWith('+'));

    // 2. Send loop via D7 Networks (sole SMS provider). ~10 SMS/sec throttle.
    let sent = 0;
    let failed = 0;
    for (const user of recipients) {
      const result = await sendSmsViaD7(user.phone!, smsBody, { tracker: supabase, eventType: 'bulk_campaign' });
      if (result.ok) sent++; else failed++;
      await sleep(100);
    }

    return new Response(JSON.stringify({ ok: true, sent, failed, total_targets: recipients.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[send-bulk-sms] exception', err);
    return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
