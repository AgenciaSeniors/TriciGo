// ============================================================
// TriciGo — send-email edge function
//
// BUG-191 fix: previously accepted any authenticated user's JWT
// and any recipient_email — phishing vector. Now service_role
// only. All legitimate callers (behavioral-emails EF, DB triggers
// via pg_net) already use service_role.
//
// 2026-05-12 fixup:
//   - Auth: accept either `apikey` header OR `Authorization: Bearer`
//     and exact-match against SUPABASE_SERVICE_ROLE_KEY. Supabase
//     Gateway can strip `apikey` in some configs; the Authorization
//     fallback prevents false 401s without weakening the gate. (An
//     earlier draft also accepted any token whose JWT payload claimed
//     role=service_role without verifying the signature — Codex flagged
//     it as a phishing vector and the JWT path was removed.)
//   - Subject: RFC 2047 encoded-word for non-ASCII chars so Subject
//     headers don't show as garbage in older mail clients.
//   - Attachments: optional `attachments: [{filename, content_base64}]`
//     forwarded to Resend (used by ad-hoc preview tooling; the real
//     receipt flow keeps using Resend direct in
//     generate-recharge-receipt because it owns the PDF generation).
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

interface EmailAttachment {
  filename: string;
  content_base64: string;
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
  /** Optional attachments (PDF, image, etc) forwarded to Resend. */
  attachments?: EmailAttachment[];
}

/**
 * Decide between rendering via the typed template registry
 * (preferred — used for welcome / win_back / wallet_receipt /
 * ride_receipt / driver_under_review) and the legacy
 * "template is the HTML string" path that older callers still
 * rely on.
 */
function resolveTemplate(
  template: string,
  data: Record<string, unknown>,
  subjectOverride: string | undefined,
): { subject: string; html: string } {
  if (isTemplateKey(template)) {
    return renderRegistryTemplate(template as TemplateKey, data, subjectOverride);
  }
  let html = template;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    html = html.replace(placeholder, String(value ?? ''));
  }
  return { subject: subjectOverride ?? '', html };
}

/**
 * Read the caller-supplied service-role key from either header.
 * Supabase Gateway sometimes strips `apikey` (especially when the
 * function is called through pg_net DB triggers), so we also accept
 * `Authorization: Bearer <token>` and compare both against the
 * exact env-var value.
 *
 * Security note: we used to fall back to a JWT-decode that trusted
 * a `role: service_role` claim WITHOUT verifying the signature.
 * Codex review on PR #130 caught that: anyone could forge a JWT
 * (sign with garbage), claim service_role, and send mail as
 * TriciGo to arbitrary recipients — a phishing vector and a
 * regression of the BUG-191 fix this function exists for. The
 * decode fallback is gone; only exact match wins.
 */
function extractCallerKey(req: Request): string {
  const apikey = req.headers.get('apikey') ?? '';
  if (apikey) return apikey;
  const auth = req.headers.get('authorization') ?? '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

/**
 * RFC 2047 encoded-word for Subject lines with non-ASCII chars.
 * Mail clients that don't honor charset declarations on the Subject
 * header would otherwise render tildes/ñ/em-dashes as garbage.
 */
function encodeSubject(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-email:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const callerKey = extractCallerKey(req);
    if (callerKey !== serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: send-email is internal-only' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const { template, data, recipient_email, subject, attachments } = (await req.json()) as EmailRequest;

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

    if (!rendered.subject) {
      return new Response(
        JSON.stringify({ error: 'subject is required for non-registry templates' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const resendBody: Record<string, unknown> = {
      from: 'TriciGo <noreply@tricigo.com>',
      to: recipient_email,
      subject: encodeSubject(rendered.subject),
      html: rendered.html,
    };
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      resendBody.attachments = attachments.map(a => ({
        filename: a.filename,
        content: a.content_base64,
      }));
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
      body: JSON.stringify(resendBody),
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
