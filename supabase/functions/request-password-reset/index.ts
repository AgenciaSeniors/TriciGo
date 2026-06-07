// ============================================================
// TriciGo — request-password-reset
//
// Inicia el flow de recovery. El usuario elige email o phone:
//   • email: chequea que existe + está verificado, manda magic link
//   • phone: chequea que existe, manda OTP via send-sms-otp
//
// El JWT del email reset link es generado por Supabase
// `auth.admin.generateLink({ type: 'recovery' })` — TTL nativo +
// invalidación post-uso. Nosotros solo dispatch del email.
//
// Rate limit: 3 intentos / hora por identifier (SMS cost guard).
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ResetRequest {
  email?: string;
  phone?: string;
}

const PUBLIC_BASE_URL = Deno.env.get('PUBLIC_TRACKING_BASE_URL') ?? 'https://tricigo.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supaAdmin = createClient(supabaseUrl, serviceRoleKey);

    const { email, phone } = (await req.json()) as ResetRequest;
    if (!email && !phone) {
      return new Response(JSON.stringify({ error: 'email or phone required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Rate limit check (simple: count requests last hour by identifier)
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const identifier = email ?? phone!;
    const { count } = await supaAdmin
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'password_reset_requested')
      .gte('created_at', oneHourAgo)
      .filter('details->>identifier', 'eq', identifier);
    if ((count ?? 0) >= 3) {
      return new Response(JSON.stringify({ error: 'rate_limited', retry_after_minutes: 60 }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (email) {
      // Lookup user en public.users (más liviano que admin.listUsers)
      const { data: dbUser } = await supaAdmin
        .from('users').select('id, full_name, email_verified_at')
        .eq('email', email).maybeSingle();
      // Devolvemos success aunque no exista (anti-enumeration). Solo
      // mandamos email si hay match real + email verificado.
      if (dbUser && dbUser.email_verified_at) {
        // Generar magic link de recovery (Supabase nativo)
        const { data: linkData, error: linkErr } = await supaAdmin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo: `${PUBLIC_BASE_URL}/auth/reset-password` },
        });
        if (!linkErr && linkData.properties?.action_link) {
          // Mandar via send-email function con template password_reset
          await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceRoleKey}`,
              'apikey': serviceRoleKey,
            },
            body: JSON.stringify({
              template: 'password_reset',
              recipient_email: email,
              data: {
                full_name: dbUser.full_name ?? '',
                reset_link: linkData.properties.action_link,
              },
            }),
          }).catch(() => {});
        }
      }
      // Audit
      await supaAdmin.from('audit_log').insert({
        action: 'password_reset_requested',
        actor_id: dbUser?.id ?? null,
        target_id: dbUser?.id ?? null,
        details: { channel: 'email', identifier: email },
      }).then(() => {}, () => {});
      return new Response(JSON.stringify({ success: true, channel: 'email' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Phone path: invocar send-sms-otp con flag reset_mode
    const { data: dbUser } = await supaAdmin
      .from('users').select('id, full_name')
      .eq('phone', phone).maybeSingle();
    if (dbUser) {
      // Reusar send-sms-otp; el verify-otp normal va a crear session, después
      // mobile redirige a set-password.
      await fetch(`${supabaseUrl}/functions/v1/send-sms-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
        },
        body: JSON.stringify({ phone, mode: 'reset' }),
      }).catch(() => {});
    }
    await supaAdmin.from('audit_log').insert({
      action: 'password_reset_requested',
      actor_id: dbUser?.id ?? null,
      target_id: dbUser?.id ?? null,
      details: { channel: 'phone', identifier: phone },
    }).then(() => {}, () => {});
    return new Response(JSON.stringify({ success: true, channel: 'phone' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'internal', detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
