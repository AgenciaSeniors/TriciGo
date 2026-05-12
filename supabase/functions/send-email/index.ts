// ============================================================
// TriciGo — send-email edge function
//
// BUG-191 fix: previously accepted any authenticated user's JWT
// and any recipient_email — phishing vector. Now service_role
// only. All legitimate callers (behavioral-emails EF, DB triggers
// via pg_net) already use service_role.
// ============================================================

import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import {
  isTemplateKey,
  renderTemplate as renderRegistryTemplate,
  type TemplateKey,
} from '../_shared/email-templates/index.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

interface EmailRequest {
  /**
   * Either a registered template key (e.g. "welcome") OR a raw HTML
   * string with {{placeholder}} markers. Keys win — see resolveTemplate.
   */
  template: string;
  data: Record<string, unknown>;
  recipient_email: string;
  /**
   * Subject line. For registered templates this acts as an override;
   * if omitted, the template's default subject is used.
   */
  subject?: string;
  locale?: 'en' | 'es';
}

/**
 * Decide between rendering via the typed template registry
 * (preferred — used for welcome / win_back / wallet_receipt) and
 * the legacy "template is the HTML string" path that older callers
 * (DB triggers, ad-hoc admin tools) still rely on.
 */
function resolveTemplate(
  template: string,
  data: Record<string, unknown>,
  subjectOverride: string | undefined,
): { subject: string; html: string } {
  if (isTemplateKey(template)) {
    return renderRegistryTemplate(template as TemplateKey, data, subjectOverride);
  }

  // Legacy path: template IS the HTML body. Substitute {{vars}}.
  let html = template;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    html = html.replace(placeholder, String(value ?? ''));
  }
  // The legacy path always required `subject`; the registry path
  // tolerates missing subject. We keep the requirement for legacy
  // callers in the request handler below.
  return { subject: subjectOverride ?? '', html };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-email:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // BUG-191: service_role only.
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const apiKey = req.headers.get('apikey') ?? '';
    if (apiKey !== serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: send-email is internal-only' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { template, data, recipient_email, subject } = (await req.json()) as EmailRequest;

    if (!recipient_email || !template) {
      return new Response(
        JSON.stringify({ error: 'recipient_email and template are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipient_email)) {
      return new Response(
        JSON.stringify({ error: 'Invalid email format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      return new Response(
        JSON.stringify({ error: 'Resend not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const rendered = resolveTemplate(template, data ?? {}, subject);

    // Legacy callers must supply `subject` — registry templates have
    // their own default. Catch the gap explicitly.
    if (!rendered.subject) {
      return new Response(
        JSON.stringify({ error: 'subject is required for non-registry templates' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: 'TriciGo <noreply@tricigo.com>',
        to: recipient_email,
        subject: rendered.subject,
        html: rendered.html,
      }),
    });

    const result = await r.json();
    if (!r.ok) {
      return new Response(
        JSON.stringify({ success: false, error: 'send_failed', detail: result }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, email_id: result.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Internal server error', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
