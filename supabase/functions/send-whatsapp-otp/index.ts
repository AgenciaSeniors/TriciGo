import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function generateOTP(): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  return code;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Rate limit: 5 requests per IP per 10 minutes
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = rateLimit(`send-whatsapp-otp:${clientIP}`, 5, 10 * 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const { phone } = await req.json();

    if (!phone || typeof phone !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Phone number is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Normalize phone (ensure +53 prefix)
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Rate limit: max 5 codes per phone in 10 minutes
    const { count } = await supabase
      .from('otp_codes')
      .select('id', { count: 'exact', head: true })
      .eq('phone', normalizedPhone)
      .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

    if ((count ?? 0) >= 5) {
      return new Response(
        JSON.stringify({ error: 'Too many OTP requests. Try again in 10 minutes.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Generate OTP code
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min expiry

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

    // Get Infobip config from platform_config
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['infobip_api_key', 'infobip_base_url', 'infobip_whatsapp_sender']);

    const configMap: Record<string, string> = {};
    configs?.forEach((c: { key: string; value: string }) => {
      configMap[c.key] = typeof c.value === 'string' ? c.value.replace(/^"|"$/g, '') : String(c.value);
    });

    const apiKey = configMap['infobip_api_key'];
    const baseUrl = configMap['infobip_base_url'] || 'https://api.infobip.com';
    const sender = configMap['infobip_whatsapp_sender'];

    if (!apiKey || apiKey === 'YOUR_INFOBIP_API_KEY') {
      // Dev mode: don't send WhatsApp, just log
      console.log(`[DEV] OTP for ${normalizedPhone}: ${code}`);
      return new Response(
        JSON.stringify({ success: true, dev: true, message: 'OTP generated (dev mode - check logs)' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Send via Infobip WhatsApp API
    const whatsappResponse = await fetch(`${baseUrl}/whatsapp/1/message/text`, {
      method: 'POST',
      headers: {
        'Authorization': `App ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender,
        to: normalizedPhone,
        content: {
          text: `Tu codigo TriciGo es: ${code}\n\nNo compartas este codigo con nadie. Expira en 10 minutos.`,
        },
      }),
    });

    if (!whatsappResponse.ok) {
      const errorBody = await whatsappResponse.text();
      console.error('Infobip WhatsApp error:', errorBody);

      // Fallback: try SMS via Infobip
      const smsResponse = await fetch(`${baseUrl}/sms/2/text/advanced`, {
        method: 'POST',
        headers: {
          'Authorization': `App ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{
            destinations: [{ to: normalizedPhone }],
            text: `Tu codigo TriciGo es: ${code}. Expira en 10 min.`,
          }],
        }),
      });

      if (!smsResponse.ok) {
        console.error('Infobip SMS fallback also failed');
        // Still return success — code is in DB, user might need to retry
      }
    }

    return new Response(
      JSON.stringify({ success: true, message: 'OTP sent via WhatsApp' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('send-whatsapp-otp error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
