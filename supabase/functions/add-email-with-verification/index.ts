// ============================================================
// TriciGo — add-email-with-verification
//
// El user logueado agrega/cambia su email. Workflow:
//   1. EF actualiza auth.users.email + dispara magic link via
//      auth.admin.generateLink({type: 'magiclink'}).
//   2. EF manda email custom con nuestro template `email_verification`.
//   3. Cuando user click, Supabase confirma email_confirmed_at nativo.
//   4. EF aparte (verify-email-magic-link callback) marca
//      public.users.email_verified_at.
//
// Aquí solo paso 1+2.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PUBLIC_BASE_URL = Deno.env.get('PUBLIC_TRACKING_BASE_URL') ?? 'https://tricigo.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supaUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { email } = (await req.json()) as { email: string };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: 'invalid_email' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supaAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Check if email is already taken por otro user
    const { data: existing } = await supaAdmin
      .from('users').select('id').eq('email', email).maybeSingle();
    if (existing && existing.id !== user.id) {
      return new Response(JSON.stringify({ error: 'email_already_taken' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update email en auth.users (esto manda magic link por defecto si
    // está configurado, pero queremos custom template, así que generamos
    // el link manualmente con `email_change` type).
    const { error: updateErr } = await supaAdmin.auth.admin.updateUserById(user.id, {
      email,
      email_confirm: false,  // requerimos verificación
    });
    if (updateErr) {
      return new Response(JSON.stringify({ error: 'update_failed', detail: updateErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generar magic link custom
    const { data: linkData, error: linkErr } = await supaAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: `${PUBLIC_BASE_URL}/auth/email-confirmed` },
    });
    if (linkErr || !linkData.properties?.action_link) {
      return new Response(JSON.stringify({ error: 'link_generation_failed', detail: linkErr?.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get user full_name
    const { data: dbUser } = await supaAdmin
      .from('users').select('full_name').eq('id', user.id).maybeSingle();

    // Mandar email custom
    await fetch(`${supabaseUrl}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify({
        template: 'email_verification',
        recipient_email: email,
        data: {
          full_name: dbUser?.full_name ?? '',
          email,
          verification_link: linkData.properties.action_link,
        },
      }),
    }).catch(() => {});

    // Sync email a public.users (sin verified_at todavía)
    await supaAdmin.from('users').update({ email, email_verified_at: null }).eq('id', user.id);

    // Audit (security_audit_log, 00417 — the old audit_log target had no
    // action/actor_id/details columns so this insert silently failed).
    await supaAdmin.from('security_audit_log').insert({
      action: 'email_change_requested',
      actor_id: user.id,
      target_id: user.id,
      details: { new_email: email },
    }).then(() => {}, () => {});

    return new Response(JSON.stringify({ success: true, message: 'check_email_for_link' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'internal', detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
