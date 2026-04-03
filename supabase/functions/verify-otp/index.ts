import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS: restrict to allowed origins ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] ?? 'https://tricigo.com');
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) });
  }

  try {
    // Rate limit: 10 requests per IP per minute
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = rateLimit(`verify-otp:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const { phone, code } = await req.json();

    if (!phone || !code) {
      return new Response(
        JSON.stringify({ error: 'Phone and code are required' }),
        { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // Supabase client (needed for both Cuba and user creation)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Route by country: Cuba → otp_codes table, rest → Twilio Verify ──
    if (normalizedPhone.startsWith('+53')) {
      // ── Cuba → verify against otp_codes table ──
      const { data: otpRecord } = await supabase
        .from('otp_codes')
        .select('*')
        .eq('phone', normalizedPhone)
        .is('verified_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!otpRecord) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired code' }),
          { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      // Increment attempts
      await supabase.from('otp_codes')
        .update({ attempts: otpRecord.attempts + 1 })
        .eq('id', otpRecord.id);

      if (otpRecord.attempts >= 5) {
        return new Response(
          JSON.stringify({ error: 'Too many attempts. Request a new code.' }),
          { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      if (otpRecord.code !== code) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired code' }),
          { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      // Mark as verified
      await supabase.from('otp_codes')
        .update({ verified_at: new Date().toISOString() })
        .eq('id', otpRecord.id);

      console.log('Cuba OTP verified for:', normalizedPhone);

    } else {
      // ── Rest of world → Twilio Verify Check API ──
      const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
      const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
      const verifySid = Deno.env.get('TWILIO_VERIFY_SERVICE_SID');

      if (!accountSid || !authToken || !verifySid) {
        return new Response(
          JSON.stringify({ error: 'Verification service not configured' }),
          { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      const twilioUrl = `https://verify.twilio.com/v2/Services/${verifySid}/VerificationCheck`;
      const verifyBody = new URLSearchParams({
        To: normalizedPhone,
        Code: code,
      });

      const checkResponse = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: verifyBody.toString(),
      });

      const checkResult = await checkResponse.json();
      console.log('Twilio Verify Check:', JSON.stringify({ status: checkResult.status, valid: checkResult.valid }));

      if (!checkResponse.ok || checkResult.status !== 'approved') {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired code' }),
          { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }
    }

    // ── Code verified — create or find user (shared for both paths) ──

    // Find or create user in auth.users
    const devEmail = `phone_${normalizedPhone.replace(/\+/g, '')}@tricigo.app`;

    // Try to find existing user by email
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u) => u.email === devEmail || u.phone === normalizedPhone,
    );

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      // Update phone if needed
      if (!existingUser.phone || existingUser.phone !== normalizedPhone) {
        await supabase.auth.admin.updateUserById(userId, {
          phone: normalizedPhone,
          phone_confirm: true,
        });
      }
    } else {
      // Create new user
      const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
        email: devEmail,
        phone: normalizedPhone,
        phone_confirm: true,
        email_confirm: true,
        password: `otp_${Date.now()}_${crypto.randomUUID()}`,
        user_metadata: { phone: normalizedPhone },
      });

      if (createError || !newUser.user) {
        console.error('Failed to create user:', createError);
        return new Response(
          JSON.stringify({ error: 'Failed to create account' }),
          { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      userId = newUser.user.id;

      // Fix NULL token columns (prevent "Database error querying schema")
      await supabase.rpc('exec_sql', {
        query: `UPDATE auth.users SET
          confirmation_token = COALESCE(confirmation_token, ''),
          email_change = COALESCE(email_change, ''),
          email_change_token_new = COALESCE(email_change_token_new, ''),
          recovery_token = COALESCE(recovery_token, ''),
          email_change_token_current = COALESCE(email_change_token_current, ''),
          phone_change_token = COALESCE(phone_change_token, ''),
          phone_change = COALESCE(phone_change, ''),
          reauthentication_token = COALESCE(reauthentication_token, '')
        WHERE id = '${userId}'`,
      }).catch(() => {
        // If exec_sql RPC doesn't exist, try direct update
        console.warn('exec_sql RPC not available, NULL tokens may cause issues');
      });
    }

    // Generate a magic link to create a session
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: devEmail,
    });

    if (linkError || !linkData) {
      console.error('Failed to generate session link:', linkError);
      // Fallback: sign in with password
      const tempPassword = `otp_${crypto.randomUUID()}`;
      await supabase.auth.admin.updateUserById(userId, { password: tempPassword });

      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: devEmail,
        password: tempPassword,
      });

      if (signInError || !signInData.session) {
        return new Response(
          JSON.stringify({ error: 'Failed to create session' }),
          { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          session: {
            access_token: signInData.session.access_token,
            refresh_token: signInData.session.refresh_token,
            expires_in: signInData.session.expires_in,
            user: signInData.session.user,
          },
        }),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Extract token from magic link and exchange it
    const url = new URL(linkData.properties.action_link);
    const token = url.searchParams.get('token') ?? url.hash?.split('access_token=')[1]?.split('&')[0];

    if (!token) {
      // Fallback approach
      const tempPassword = `otp_${crypto.randomUUID()}`;
      await supabase.auth.admin.updateUserById(userId, { password: tempPassword });
      const { data: fbData } = await supabase.auth.signInWithPassword({
        email: devEmail,
        password: tempPassword,
      });

      return new Response(
        JSON.stringify({
          success: true,
          session: fbData?.session ? {
            access_token: fbData.session.access_token,
            refresh_token: fbData.session.refresh_token,
            expires_in: fbData.session.expires_in,
            user: fbData.session.user,
          } : null,
        }),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    // Verify the magic link token to get a session
    const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: 'magiclink',
    });

    if (verifyError || !verifyData.session) {
      return new Response(
        JSON.stringify({ error: 'Failed to verify session' }),
        { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        session: {
          access_token: verifyData.session.access_token,
          refresh_token: verifyData.session.refresh_token,
          expires_in: verifyData.session.expires_in,
          user: verifyData.session.user,
        },
      }),
      { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('verify-otp error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    );
  }
});
