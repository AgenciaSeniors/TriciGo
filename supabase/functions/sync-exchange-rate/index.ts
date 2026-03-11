// ============================================================
// TriciGo — Sync Exchange Rate Edge Function
// Fetches the current USD/CUP rate from ElToque API
// and stores it in the exchange_rates table.
//
// Designed to be called via cron (pg_cron) or manually.
// If no API token is configured, exits silently.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Read config: token + auto_update flag
    const { data: configs } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', ['eltoque_api_token', 'exchange_rate_auto_update']);

    const configMap: Record<string, string> = {};
    (configs ?? []).forEach((c: { key: string; value: string }) => {
      configMap[c.key] = c.value;
    });

    const token = configMap['eltoque_api_token'] ?? '';
    const autoUpdate = configMap['exchange_rate_auto_update'] ?? 'true';

    // If no token or auto-update disabled, exit silently
    if (!token || token.trim() === '') {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'no_token' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (autoUpdate === 'false') {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: 'auto_update_disabled' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Fetch from ElToque API
    const eltoqueRes = await fetch('https://tasas.eltoque.com/v1/trmi', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!eltoqueRes.ok) {
      const body = await eltoqueRes.text();
      console.error(`ElToque API error: ${eltoqueRes.status} - ${body}`);
      return new Response(
        JSON.stringify({ ok: false, error: `eltoque_api_${eltoqueRes.status}`, detail: body }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const eltoqueData = await eltoqueRes.json();

    // 3. Parse the USD/CUP rate
    // ElToque returns { tasas: { USD: { ... median, ... } } } or similar structure
    let usdCupRate: number | null = null;

    // Try different response shapes the API may return
    if (eltoqueData?.tasas?.USD?.median) {
      usdCupRate = Number(eltoqueData.tasas.USD.median);
    } else if (eltoqueData?.USD?.median) {
      usdCupRate = Number(eltoqueData.USD.median);
    } else if (eltoqueData?.tasas?.USD?.venta) {
      usdCupRate = Number(eltoqueData.tasas.USD.venta);
    } else if (typeof eltoqueData?.USD === 'number') {
      usdCupRate = eltoqueData.USD;
    }

    if (!usdCupRate || isNaN(usdCupRate) || usdCupRate <= 0) {
      console.error('Could not parse USD/CUP rate from ElToque response:', JSON.stringify(eltoqueData));
      return new Response(
        JSON.stringify({ ok: false, error: 'parse_error', data: eltoqueData }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 4. Unset current rate
    await supabase
      .from('exchange_rates')
      .update({ is_current: false })
      .eq('is_current', true);

    // 5. Insert new rate
    const { error: insertError } = await supabase
      .from('exchange_rates')
      .insert({
        source: 'eltoque_api',
        usd_cup_rate: usdCupRate,
        fetched_at: new Date().toISOString(),
        is_current: true,
      });

    if (insertError) {
      console.error('Error inserting exchange rate:', insertError);
      return new Response(
        JSON.stringify({ ok: false, error: 'insert_error', detail: insertError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`Exchange rate synced: 1 USD = ${usdCupRate} CUP (source: eltoque_api)`);

    return new Response(
      JSON.stringify({ ok: true, usd_cup_rate: usdCupRate, source: 'eltoque_api' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Unexpected error in sync-exchange-rate:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
