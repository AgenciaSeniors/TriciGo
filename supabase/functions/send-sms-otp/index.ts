import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') ?? 'https://tricigo.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function generateOTP(): string {
  // Use cryptographically secure random number generator
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (100000 + (array[0] % 900000)).toString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { phone } = await req.json();

    if (!phone || typeof phone !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Phone number is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Normalize phone: ensure starts with + and strip for SMSPM (needs digits only)
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    const digitsOnly = normalizedPhone.replace(/\+/g, '');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Rate limit: max 3 codes per phone in 10 minutes
    const { count } = await supabase
      .from('otp_codes')
      .select('id', { count: 'exact', head: true })
      .eq('phone', normalizedPhone)
      .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

    if ((count ?? 0) >= 3) {
      return new Response(
        JSON.stringify({ error: 'Demasiados intentos. Espera 10 minutos.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Generate OTP code
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Store in database
    const { error: insertError } = await supabase
      .from('otp_codes')
      .insert({ phone: normalizedPhone, code, expires_at: expiresAt });

    if (insertError) {
      console.error('Failed to store OTP:', insertError);
      return new Response(
        JSON.stringify({ error: 'Failed to generate OTP' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Get SMSPM config from platform_config
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['smspm_hash', 'smspm_token', 'smspm_sender']);

    const configMap: Record<string, string> = {};
    configs?.forEach((c: { key: string; value: string }) => {
      configMap[c.key] = typeof c.value === 'string' ? c.value.replace(/^"|"$/g, '') : String(c.value);
    });

    const hash = configMap['smspm_hash'];
    const token = configMap['smspm_token'];
    const sender = configMap['smspm_sender'] || 'TriciGo';

    if (!hash || hash === 'YOUR_SMSPM_HASH') {
      // Dev mode: don't send SMS, just log
      console.log(`[DEV] OTP for ${normalizedPhone}: ${code}`);
      return new Response(
        JSON.stringify({ success: true, dev: true, message: 'OTP generated (dev mode - check logs)' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Send via SMSPM API
    const smspmUrl = new URL('https://api.smspm.com');
    smspmUrl.searchParams.set('hash', hash);
    smspmUrl.searchParams.set('token', token);
    smspmUrl.searchParams.set('toNumber', digitsOnly);
    smspmUrl.searchParams.set('fromNumber', sender);
    smspmUrl.searchParams.set('text', `Tu codigo TriciGo: ${code}. No lo compartas. Expira en 10 min.`);

    const smsResponse = await fetch(smspmUrl.toString());
    const smsResult = await smsResponse.json();

    console.log('SMSPM response:', JSON.stringify(smsResult));

    if (!smsResponse.ok) {
      console.error('SMSPM error:', smsResult);
      // Code is saved in DB — user can retry
      return new Response(
        JSON.stringify({ success: false, error: 'SMS send failed, try again' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: 'OTP sent via SMS' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('send-sms-otp error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
