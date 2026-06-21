// ============================================================
// TriciGo — set-password-after-otp
//
// Setea la password del user que recién verificó el OTP. El JWT del
// caller (post-OTP) prueba que el user controla el phone, así que es
// seguro permitirle setear su propia password.
//
// Flow:
//   1. Mobile manda OTP, recibe session de Supabase Auth.
//   2. Mobile redirige a "Configurá tu password".
//   3. Mobile llama esta EF con el JWT en Authorization + new password.
//   4. EF valida JWT, llama auth.admin.updateUserById, marca timestamp.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SetPasswordRequest { password: string; }

function isValidPassword(p: string): { valid: boolean; reason?: string } {
  if (typeof p !== 'string') return { valid: false, reason: 'password debe ser string' };
  if (p.length < 8) return { valid: false, reason: 'password debe tener al menos 8 caracteres' };
  if (!/[a-zA-Z]/.test(p)) return { valid: false, reason: 'password debe tener al menos 1 letra' };
  if (!/\d/.test(p)) return { valid: false, reason: 'password debe tener al menos 1 número' };
  return { valid: true };
}

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

    // Validate JWT and get user
    const supaUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Require phone confirmed (the OTP they just verified)
    if (!user.phone_confirmed_at) {
      return new Response(JSON.stringify({ error: 'phone_not_confirmed' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { password } = (await req.json()) as SetPasswordRequest;
    const validation = isValidPassword(password);
    if (!validation.valid) {
      return new Response(JSON.stringify({ error: 'invalid_password', detail: validation.reason }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update password using admin client
    const supaAdmin = createClient(supabaseUrl, serviceRoleKey);
    const { error: updateErr } = await supaAdmin.auth.admin.updateUserById(user.id, { password });
    if (updateErr) {
      return new Response(JSON.stringify({ error: 'update_failed', detail: updateErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mark password_set_at en public.users
    await supaAdmin.from('users').update({ password_set_at: new Date().toISOString() }).eq('id', user.id);

    // Audit — AUD2-006: write to security_audit_log (whose columns are action/actor_id/target_id/
    // details). The previous target `audit_log` has a different schema (table_name/operation/...), so
    // the insert errored on unknown columns and was swallowed by the .then(noop) → the password_set
    // security event was never recorded.
    await supaAdmin.from('security_audit_log').insert({
      action: 'password_set',
      actor_id: user.id,
      target_id: user.id,
      details: { method: 'post_otp' },
    }).then(() => {}, () => {});

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'internal', detail: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
