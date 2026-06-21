// ============================================================
// TriciGo — send-bulk-email edge function
//
// Sends a marketing/campaign email to many users at once via Resend.
// Called from the admin /campaigns page when the user picks
// channel='email' or 'both'. Non-blocking failures per-recipient so
// one bad address doesn't tank the whole batch.
//
// Rate-limited to ~20 emails/sec to respect Resend limits.
//
// BUG-180 fix: this EF previously had NO authentication. Any
// authenticated user could call it with arbitrary user_ids,
// subject, and HTML body, sending phishing emails from our
// noreply@tricigo.com address and burning the Resend quota.
// Now requires admin role (or service_role for cron/automation).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface BulkEmailRequest {
  user_ids: string[];
  subject: string;
  body_html: string;
  promo_code_id?: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

    const body: BulkEmailRequest = await req.json();
    const { user_ids, subject, body_html, promo_code_id } = body;

    if (!Array.isArray(user_ids) || user_ids.length === 0 || !subject) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_params' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // 1. Fetch emails
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, full_name')
      .in('id', user_ids)
      .not('email', 'is', null);
    if (error) throw error;

    const recipients = (users ?? []).filter((u) => u.email && u.email.includes('@'));

    // 2. Optional promo code lookup
    let promoCode: string | null = null;
    if (promo_code_id) {
      const { data: promo } = await supabase.from('promotions').select('code').eq('id', promo_code_id).single();
      promoCode = promo?.code ?? null;
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      return new Response(JSON.stringify({ ok: false, error: 'resend_not_configured', recipients: recipients.length }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Send in a loop with 50ms throttle (~20/sec)
    let sent = 0;
    let failed = 0;
    for (const user of recipients) {
      const personalizedHtml = `
<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>${escapeHtml(subject)}</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #FF4D00;">Hola ${escapeHtml(user.full_name ?? '')},</h2>
  ${body_html}
  ${promoCode ? `<div style="margin: 20px 0; padding: 16px; background: #fff3e0; border-radius: 8px; text-align: center;">
    <p style="margin: 0; color: #666; font-size: 12px;">Usá el código:</p>
    <p style="margin: 4px 0 0 0; font-family: ui-monospace, monospace; font-size: 22px; font-weight: 700; color: #FF4D00;">${escapeHtml(promoCode)}</p>
  </div>` : ''}
  <p style="color: #777; font-size: 11px; margin-top: 32px;">TriciGo · tricigo.com</p>
</body></html>`;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
          body: JSON.stringify({
            from: 'TriciGo <noreply@tricigo.com>',
            reply_to: 'soporte@tricigo.com', // replies reach the support inbox
            to: user.email,
            subject,
            html: personalizedHtml,
          }),
        });
        if (r.ok) sent++; else failed++;
      } catch {
        failed++;
      }
      await sleep(50);
    }

    return new Response(JSON.stringify({ ok: true, sent, failed, total_targets: recipients.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[send-bulk-email] exception', err);
    return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
