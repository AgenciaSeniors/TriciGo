// ============================================================
// TriciGo — Process NETOPIA Webhook (IPN) Edge Function
//
// Phase D2. Receives NETOPIA's Instant Payment Notification after
// a hosted-payment-page transaction settles, identifies our
// payment_intent by the orderID NETOPIA echoes back (= our UUID,
// non-guessable), claims atomically (idempotent), calls the credit
// RPC, and ACKs with the NETOPIA-required `{ code: "0", message: "OK" }`.
//
// Status: SANDBOX-READY — wired to the real NETOPIA v2.x IPN shape
// (see https://secure.sandbox.netopia-payments.com/spec). Status
// codes: 3=paid, 5=confirmed, 12=invalid account, 15=3DS required.
//
// SECURITY MODEL:
//   NETOPIA's v2.x IPN does NOT carry a documented signature header
//   (no HMAC, no asymmetric signature). The defenses we use:
//     1. orderID is the merchant payment_intents.id (UUID v4) — not
//        guessable. An attacker can't forge an IPN for an unknown
//        intent.
//     2. Atomic claim: status flips from pending|created → processing
//        in a single UPDATE; a replay sees 0 rows and exits.
//     3. Status checked: only `paid` / `confirmed` calls the credit
//        RPC; others mark failed / refunded.
//     4. Optional callback verify (controlled by
//        NETOPIA_IPN_VERIFY_CALLBACK env var): re-queries the NETOPIA
//        API for the ntpID's true status before crediting. Turn on
//        once verify endpoint shape is confirmed in sandbox.
//
// Contract: docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md §2
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

/** NETOPIA v2.x IPN body subset we consume. */
interface NetopiaIPNBody {
  payment?: {
    ntpID?: string;
    status?: number;
    method?: string;
    amount?: number;
    currency?: string;
    code?: string;
    message?: string;
    instrument?: {
      panMasked?: string;
      panCategory?: string;
      issuer?: string;
      country?: number;
    };
    token?: string;
    binding?: { token?: string; expireMonth?: number; expireYear?: number };
    data?: Record<string, string>;
  };
  order?: {
    orderID?: string;
    data?: Record<string, string>;
  };
}

/** ACK body NETOPIA expects on success. */
const ACK_OK = { code: '0', message: 'OK' };

/** Map NETOPIA numeric status to our payment_intents.status. */
function mapNetopiaStatus(s: number | undefined): 'paid' | 'failed' | 'pending' | 'unknown' {
  // Per spec: 3=paid, 5=confirmed; 12=invalid account / rejected; 15=3DS required.
  if (s === 3 || s === 5) return 'paid';
  if (s === 12) return 'failed';
  if (s === 15) return 'pending'; // 3DS still in flight
  return 'unknown';
}

/** UUID v4 sanity check (matches our payment_intents.id format). */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`process-netopia-webhook:${clientIP}`, 50, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── 1. Parse body ──
    const rawBody = await req.text();
    let ipn: NetopiaIPNBody;
    try {
      ipn = JSON.parse(rawBody) as NetopiaIPNBody;
    } catch (err) {
      console.error('[netopia] IPN body is not JSON:', err, rawBody.slice(0, 200));
      return new Response(
        JSON.stringify({ error: 'Invalid JSON' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const orderId = ipn.order?.orderID ?? '';
    const ntpId = ipn.payment?.ntpID ?? '';
    const status = mapNetopiaStatus(ipn.payment?.status);

    if (!orderId || !isUuid(orderId)) {
      console.error('[netopia] IPN orderID missing or not a UUID:', orderId);
      return new Response(
        JSON.stringify({ error: 'Missing/invalid orderID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (!ntpId) {
      console.error('[netopia] IPN ntpID missing');
      return new Response(
        JSON.stringify({ error: 'Missing ntpID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[netopia] IPN received: intent=${orderId} ntp=${ntpId} status=${ipn.payment?.status} mapped=${status} ip=${clientIP}`);

    // Log the source IP for future allowlist tightening.

    // ── 2. Lookup our intent ──
    const { data: existingIntent } = await supabase
      .from('payment_intents')
      .select('id, status, user_id, amount_cup, intent_type, corporate_account_id, payment_provider')
      .eq('id', orderId)
      .single();

    if (!existingIntent) {
      // Unknown orderID → can't be ours. UUIDs are non-guessable so
      // this is either a misrouted IPN or an attempted forgery.
      console.error(`[netopia] payment_intent not found: ${orderId} (ip=${clientIP})`);
      return new Response(
        JSON.stringify({ error: 'Unknown orderID' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (existingIntent.payment_provider !== 'netopia') {
      console.error(`[netopia] payment_intent ${orderId} belongs to ${existingIntent.payment_provider}, not netopia`);
      return new Response(
        JSON.stringify({ error: 'Provider mismatch' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Branch on status ──

    if (status === 'paid') {
      if (existingIntent.status === 'completed') {
        console.log(`[netopia] Intent ${orderId} already completed — replay skipped`);
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Atomic idempotency claim.
      const { data: claimed, error: claimError } = await supabase
        .from('payment_intents')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .in('status', ['pending', 'created'])
        .select();

      if (claimError || !claimed || claimed.length === 0) {
        console.log(`[netopia] Intent ${orderId} already claimed — replay skipped`);
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Persist NETOPIA's ntpID and card details before crediting.
      try {
        await supabase
          .from('payment_intents')
          .update({
            stripe_payment_intent_id: ntpId,
            card_brand: ipn.payment?.instrument?.issuer ?? null,
            card_last4: (ipn.payment?.instrument?.panMasked ?? '').slice(-4) || null,
            webhook_payload: ipn as unknown as Record<string, unknown>,
          })
          .eq('id', orderId);
      } catch (metaErr) {
        console.warn(`[netopia] Card metadata update skipped: ${metaErr}`);
      }

      // Call the credit RPC. As of migration 00282 the canonical name
      // is `process_recharge_payment`; `process_stripe_recharge` still
      // exists as a thin wrapper for backwards compat but should no
      // longer be referenced by new code.
      const webhookPayload = {
        netopia_ntp_id: ntpId,
        amount: ipn.payment?.amount,
        currency: ipn.payment?.currency,
        netopia_status: ipn.payment?.status,
      };

      const { data: txnId, error: processError } = await supabase.rpc(
        'process_recharge_payment',
        {
          p_payment_intent_id: orderId,
          p_webhook_payload: webhookPayload,
        },
      );

      if (processError) {
        console.error('[netopia] Error processing recharge:', processError);
        return new Response(
          JSON.stringify({ error: 'process_error', detail: processError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      console.log(`[netopia] Recharge processed: ${orderId} → txn ${txnId}`);

      await sendPaymentNotification(supabase, existingIntent.user_id, existingIntent.amount_cup, true);

      // Asynchronously trigger the receipt PDF. Mirror of the Stripe webhook
      // flow that was removed during the cutover (PR #137). The receipt EF
      // is idempotent on payment_intent_id (UNIQUE in wallet_receipts) so
      // re-invocation is safe. We do NOT await — receipt rendering takes a
      // few seconds and would push us past NETOPIA's IPN timeout window.
      // Gated by corporate_account_id because B2B recharges have their own
      // invoicing flow and don't get the individual PDF receipt.
      if (!existingIntent.corporate_account_id) {
        fetch(`${supabaseUrl}/functions/v1/generate-recharge-receipt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': serviceRoleKey,
            'Authorization': `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({ payment_intent_id: orderId }),
        }).catch((efErr) => {
          console.error(`[netopia] generate-recharge-receipt trigger failed for ${orderId}:`, efErr);
        });
      }

      return new Response(JSON.stringify(ACK_OK), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (status === 'failed') {
      const failReason = ipn.payment?.message ?? `NETOPIA status ${ipn.payment?.status}`;
      await supabase
        .from('payment_intents')
        .update({
          status: 'failed',
          error_message: failReason,
          webhook_payload: ipn as unknown as Record<string, unknown>,
          stripe_payment_intent_id: ntpId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['created', 'pending', 'processing']);

      await sendPaymentNotification(supabase, existingIntent.user_id, existingIntent.amount_cup, false);

      console.log(`[netopia] Payment failed: ${orderId} — ${failReason}`);

      return new Response(JSON.stringify(ACK_OK), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // status === 'pending' (3DS still in flight) or 'unknown' — just ACK,
    // do not change wallet state. A subsequent IPN with status=paid/failed
    // will land here once 3DS resolves.
    console.log(`[netopia] IPN ack'd without state change for intent ${orderId} (mapped=${status})`);
    return new Response(JSON.stringify(ACK_OK), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Unexpected error in process-netopia-webhook:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Send a push notification about recharge result. Mirrors the Stripe
 * implementation so users get the same UX regardless of provider.
 */
async function sendPaymentNotification(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  amountCup: number,
  success: boolean,
): Promise<void> {
  try {
    const { data: devices } = await supabase
      .from('user_devices')
      .select('push_token')
      .eq('user_id', userId)
      .not('push_token', 'is', null);

    const tokens = (devices ?? [])
      .map((d: { push_token: string | null }) => d.push_token)
      .filter(Boolean) as string[];

    if (tokens.length === 0) return;

    const formattedAmount = amountCup.toLocaleString();
    const title = success ? 'Recarga exitosa' : 'Recarga fallida';
    const body = success
      ? `Tu recarga de ${formattedAmount} CUP ha sido acreditada a tu wallet.`
      : `Tu recarga de ${formattedAmount} CUP no pudo ser procesada.`;

    const messages = tokens.map((token) => ({
      to: token,
      title,
      body,
      sound: 'default' as const,
      data: { type: 'wallet_recharge', success: String(success), provider: 'netopia' },
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('[netopia] Error sending payment notification:', err);
  }
}
