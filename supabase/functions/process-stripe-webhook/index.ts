// ============================================================
// TriciGo — Process Stripe Webhook Edge Function
//
// Receives Stripe webhook events (payment_intent.succeeded,
// payment_intent.payment_failed, charge.refunded).
// Validates signature, calls DB RPCs to credit wallets,
// and sends push notifications.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

// ── CORS ──
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
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

  // Reject oversized payloads (1 MB)
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 1_048_576) {
    return new Response(JSON.stringify({ error: 'Payload too large' }), { status: 413 });
  }

  try {
    // Rate limit: 50 requests per IP per minute (webhooks need higher limits)
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`process-stripe-webhook:${clientIP}`, 50, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Get webhook secret from platform_config
    const { data: webhookSecretRow } = await supabase
      .from('platform_config')
      .select('value')
      .eq('key', 'stripe_webhook_secret')
      .single();

    const rawSecret = webhookSecretRow?.value;
    const webhookSecret = typeof rawSecret === 'string' && rawSecret.startsWith('"')
      ? JSON.parse(rawSecret)
      : String(rawSecret ?? '');

    if (!webhookSecret || webhookSecret.includes('REPLACE')) {
      console.error('Stripe webhook secret not configured');
      return new Response(
        JSON.stringify({ error: 'Webhook secret not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Verify Stripe signature
    const rawBody = await req.text();
    const signature = req.headers.get('stripe-signature') ?? '';

    // Get Stripe secret key for SDK initialization
    const { data: secretKeyRow } = await supabase
      .from('platform_config')
      .select('value')
      .eq('key', 'stripe_secret_key')
      .single();

    const rawSecretKey = secretKeyRow?.value;
    const stripeSecretKey = typeof rawSecretKey === 'string' && rawSecretKey.startsWith('"')
      ? JSON.parse(rawSecretKey)
      : String(rawSecretKey ?? '');

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-04-10' });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error('Invalid Stripe webhook signature:', err);
      return new Response(
        JSON.stringify({ error: 'Invalid signature' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`Stripe webhook received: ${event.type} (${event.id})`);

    // 3. Handle events
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const tricigoIntentId = pi.metadata?.tricigo_intent_id;
        const rechargeType = pi.metadata?.recharge_type ?? 'customer';

        if (!tricigoIntentId) {
          console.error('No tricigo_intent_id in Stripe PI metadata');
          return new Response(
            JSON.stringify({ ok: false, error: 'no_intent_id' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }

        // Check idempotency: is the intent already completed?
        const { data: existingIntent } = await supabase
          .from('payment_intents')
          .select('id, status, user_id, amount_cup, intent_type, corporate_account_id')
          .eq('id', tricigoIntentId)
          .single();

        if (!existingIntent) {
          console.error(`Payment intent not found: ${tricigoIntentId}`);
          return new Response(
            JSON.stringify({ ok: false, error: 'intent_not_found' }),
            { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }

        if (existingIntent.status === 'completed') {
          console.log(`[Idempotency] Intent ${tricigoIntentId} already completed — skipping`);
          return new Response(
            JSON.stringify({ ok: true, action: 'already_processed' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }

        // Atomically claim for processing
        const { data: claimed, error: claimError } = await supabase
          .from('payment_intents')
          .update({ status: 'processing', updated_at: new Date().toISOString() })
          .eq('id', tricigoIntentId)
          .in('status', ['pending', 'created'])
          .select();

        if (claimError || !claimed || claimed.length === 0) {
          console.log(`[Idempotency] Intent ${tricigoIntentId} already claimed`);
          return new Response(
            JSON.stringify({ ok: true, action: 'already_processing' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }

        // Call appropriate RPC based on recharge type
        const rpcName = rechargeType === 'driver_quota'
          ? 'process_stripe_driver_quota_recharge'
          : existingIntent.corporate_account_id
            ? 'process_stripe_recharge'  // Corporate uses same RPC (credits the corporate_account's wallet)
            : 'process_stripe_recharge';

        const webhookPayload = {
          stripe_event_id: event.id,
          stripe_pi_id: pi.id,
          amount: pi.amount,
          currency: pi.currency,
          status: pi.status,
        };

        const { data: txnId, error: processError } = await supabase.rpc(rpcName, {
          p_payment_intent_id: tricigoIntentId,
          p_webhook_payload: webhookPayload,
        });

        if (processError) {
          console.error(`Error processing Stripe recharge (${rpcName}):`, processError);
          return new Response(
            JSON.stringify({ ok: false, error: 'process_error', detail: processError.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }

        console.log(`Stripe recharge processed: ${tricigoIntentId} → txn ${txnId}`);

        // Send push notification
        await sendPaymentNotification(supabase, existingIntent.user_id, existingIntent.amount_cup, true);

        return new Response(
          JSON.stringify({ ok: true, transaction_id: txnId }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const tricigoIntentId = pi.metadata?.tricigo_intent_id;

        if (tricigoIntentId) {
          const failReason = pi.last_payment_error?.message ?? 'Payment failed';
          await supabase
            .from('payment_intents')
            .update({
              status: 'failed',
              error_message: failReason,
              webhook_payload: { stripe_event_id: event.id, error: failReason },
              updated_at: new Date().toISOString(),
            })
            .eq('id', tricigoIntentId)
            .in('status', ['created', 'pending', 'processing']);

          // Get user_id for notification
          const { data: intent } = await supabase
            .from('payment_intents')
            .select('user_id, amount_cup')
            .eq('id', tricigoIntentId)
            .single();

          if (intent) {
            await sendPaymentNotification(supabase, intent.user_id, intent.amount_cup, false);
          }

          console.log(`Stripe payment failed: ${tricigoIntentId} — ${failReason}`);
        }

        return new Response(
          JSON.stringify({ ok: true, action: 'marked_failed' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const piId = charge.payment_intent as string;

        if (piId) {
          // Find our intent by Stripe PI ID
          const { data: intent } = await supabase
            .from('payment_intents')
            .select('id, user_id, amount_cup')
            .eq('stripe_payment_intent_id', piId)
            .single();

          if (intent) {
            await supabase
              .from('payment_intents')
              .update({
                status: 'refunded',
                webhook_payload: { stripe_event_id: event.id, refund: true },
                updated_at: new Date().toISOString(),
              })
              .eq('id', intent.id);

            // TODO: Debit wallet for refund (create process_stripe_refund RPC)
            console.log(`Stripe refund recorded for intent ${intent.id}`);
          }
        }

        return new Response(
          JSON.stringify({ ok: true, action: 'refund_recorded' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
        return new Response(
          JSON.stringify({ ok: true, action: 'ignored', event_type: event.type }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
    }
  } catch (err) {
    console.error('Unexpected error in process-stripe-webhook:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Send a push notification about recharge result.
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
    const title = success ? '✅ Recarga exitosa' : '❌ Recarga fallida';
    const body = success
      ? `Tu recarga de ${formattedAmount} CUP ha sido acreditada a tu wallet.`
      : `Tu recarga de ${formattedAmount} CUP no pudo ser procesada.`;

    const messages = tokens.map((token) => ({
      to: token,
      title,
      body,
      sound: 'default' as const,
      data: { type: 'wallet_recharge', success: String(success) },
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('Error sending payment notification:', err);
  }
}
