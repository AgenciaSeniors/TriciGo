// ============================================================
// TriciGo — notify-business-movement edge function
//
// Sends an HTML email to the business notification address whenever
// a significant wallet movement happens (admin manual adjustments,
// approved recharges). Called fire-and-forget from the admin service
// layer — must never block the admin UI.
//
// Business email is read from platform_config.business_notification_email
// (set via admin /settings/platform-config). If not configured, no-op.
// Uses Resend (same as send-email function).
//
// BUG-181 fix: this EF previously had NO authentication. Any
// authenticated user could spam the business email by calling
// it with arbitrary transaction IDs. Now requires admin role
// (or service_role for cron/automation).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

type EventType = 'admin_adjustment' | 'recharge_approved';

interface NotifyRequest {
  transaction_id: string;
  event_type: EventType;
}

function eventLabel(ev: EventType): string {
  if (ev === 'admin_adjustment') return 'Ajuste manual admin';
  if (ev === 'recharge_approved') return 'Recarga aprobada';
  return ev;
}

function formatCup(n: number): string {
  return new Intl.NumberFormat('es-CU', { maximumFractionDigits: 0 }).format(n);
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

    const body: NotifyRequest = await req.json();
    const { transaction_id, event_type } = body;

    if (!transaction_id || !event_type) {
      return new Response(JSON.stringify({ ok: false, error: 'missing_params' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Fetch business email from platform_config
    const { data: cfg } = await supabase
      .from('platform_config')
      .select('key, value')
      .eq('key', 'business_notification_email')
      .single();

    const rawValue = cfg?.value;
    const businessEmail = typeof rawValue === 'string'
      ? (rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue)
      : rawValue;

    if (!businessEmail || typeof businessEmail !== 'string' || !businessEmail.includes('@')) {
      console.log('[notify-business-movement] No business email configured — skipping');
      return new Response(JSON.stringify({ ok: true, skipped: 'no_email_configured' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Load transaction + related entries, actor, target
    const { data: tx, error: txErr } = await supabase
      .from('ledger_transactions')
      .select('id, type, description, reference_type, reference_id, created_by, created_at')
      .eq('id', transaction_id)
      .single();
    if (txErr || !tx) {
      console.error('[notify-business-movement] Transaction not found:', txErr);
      return new Response(JSON.stringify({ ok: false, error: 'tx_not_found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Get the single entry (amount + account) tied to this transaction
    const { data: entries } = await supabase
      .from('ledger_entries')
      .select('amount, balance_after, account_id, wallet_accounts!inner(user_id, account_type)')
      .eq('transaction_id', transaction_id)
      .limit(1);

    const entry = entries?.[0] as {
      amount: number;
      balance_after: number;
      wallet_accounts: { user_id: string; account_type: string };
    } | undefined;

    const amount = entry?.amount ?? 0;
    const balanceAfter = entry?.balance_after ?? 0;
    const targetUserId = entry?.wallet_accounts?.user_id;
    const accountType = entry?.wallet_accounts?.account_type;

    // 4. Fetch user names
    let targetName = 'desconocido';
    let adminName = 'sistema';

    if (targetUserId) {
      const { data: u } = await supabase.from('users').select('full_name, email').eq('id', targetUserId).single();
      targetName = `${u?.full_name ?? ''} (${u?.email ?? targetUserId})`;
    }
    if (tx.created_by) {
      const { data: a } = await supabase.from('users').select('full_name, email').eq('id', tx.created_by).single();
      adminName = `${a?.full_name ?? ''} (${a?.email ?? tx.created_by})`;
    }

    // 5. Compose email
    const isCredit = amount >= 0;
    const symbol = isCredit ? '+' : '';
    const subject = `[TriciGo] ${eventLabel(event_type)}: ${symbol}${formatCup(amount)} CUP — ${targetName.split(' (')[0]}`;
    const html = `
<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><title>${escapeHtml(subject)}</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #FF4D00; border-bottom: 2px solid #FF4D00; padding-bottom: 8px;">
    ${escapeHtml(eventLabel(event_type))}
  </h2>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Monto</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; color: ${isCredit ? '#059669' : '#dc2626'}; font-weight: 700;">${symbol}${formatCup(amount)} CUP</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Cuenta</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${escapeHtml(accountType ?? '—')}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Balance nuevo</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${formatCup(balanceAfter)} CUP</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Usuario</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${escapeHtml(targetName)}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Admin</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${escapeHtml(adminName)}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Razón</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${escapeHtml(tx.description ?? '—')}</td></tr>
    <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Fecha</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${escapeHtml(tx.created_at)}</td></tr>
    <tr><td style="padding: 8px;"><strong>Transaction ID</strong></td>
        <td style="padding: 8px; text-align: right; font-family: ui-monospace, monospace; font-size: 11px; color: #555;">${escapeHtml(transaction_id)}</td></tr>
  </table>
  <p style="color: #777; font-size: 12px; margin-top: 24px;">
    Este correo se envió automáticamente. No responder.
  </p>
</body></html>`;

    // 6. Send via Resend
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      console.error('[notify-business-movement] RESEND_API_KEY not configured');
      return new Response(JSON.stringify({ ok: false, error: 'resend_not_configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: 'TriciGo <noreply@tricigo.com>',
        reply_to: 'soporte@tricigo.com', // replies reach the support inbox
        to: businessEmail,
        subject,
        html,
      }),
    });

    const result = await r.json();
    if (!r.ok) {
      console.error('[notify-business-movement] Resend error:', result);
      return new Response(JSON.stringify({ ok: false, error: 'send_failed', detail: result }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, email_id: result.id }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[notify-business-movement] exception', err);
    return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
