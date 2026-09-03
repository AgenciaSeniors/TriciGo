// process-stripe-webhook — PUBLIC (verify_jwt=false), authenticated by the
// Stripe-Signature header. On checkout.session.completed it atomically claims
// the payment_intent and credits the RECIPIENT via process_recharge_payment
// (the existing, idempotent RPC), then triggers the receipt + an in-app
// notification. Mirrors process-netopia-webhook.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getStripe, stripeWebhookSecret } from '../_shared/stripe.ts';
import {
  releasePaymentIntentClaim,
  shouldRetryUnclaimedPaymentIntent,
  type PaymentIntentClaimRepository,
} from '../_shared/payment-intent-claim.ts';

const ACK = { received: true };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const sig = req.headers.get('stripe-signature');
  const rawBody = await req.text();
  const stripe = getStripe();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig ?? '', stripeWebhookSecret());
  } catch (err) {
    console.error('[stripe-webhook] signature verify failed:', (err as Error).message);
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 400 });
  }

  // ACK any event type other than the one we credit on.
  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify(ACK), { status: 200 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const claimRepository: PaymentIntentClaimRepository = {
    async releaseIfProcessing(intentId, retryStatus) {
      const { data, error } = await supabase
        .from('payment_intents')
        .update({ status: retryStatus, updated_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'processing')
        .select('id');
      return { released: !!data?.length, error: error?.message };
    },
    async readStatus(intentId) {
      const { data, error } = await supabase
        .from('payment_intents')
        .select('status')
        .eq('id', intentId)
        .maybeSingle();
      return { status: data?.status ?? null, error: error?.message };
    },
  };

  const session = event.data.object as {
    id: string; client_reference_id?: string | null; payment_status?: string;
  };
  const intentId = session.client_reference_id;
  if (!intentId || session.payment_status !== 'paid') {
    return new Response(JSON.stringify(ACK), { status: 200 });
  }

  const { data: existingIntent } = await supabase
    .from('payment_intents')
    .select('user_id, amount_usd, amount_cup, status')
    .eq('id', intentId)
    .single();
  if (!existingIntent) return new Response(JSON.stringify(ACK), { status: 200 });
  if (existingIntent.status === 'completed') return new Response(JSON.stringify(ACK), { status: 200 }); // replay

  // Atomic idempotency claim. A completed replay is ACKed above; an active
  // processing lease gets a 503 so Stripe retries instead of dropping it.
  const { data: claimed, error: claimError } = await supabase
    .from('payment_intents')
    .update({ status: 'processing', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', intentId)
    .in('status', ['pending', 'created', 'failed', 'expired'])
    .select();
  if (claimError) {
    console.error(`[stripe-webhook] failed to claim intent ${intentId}:`, claimError.message);
    return new Response(JSON.stringify({ error: 'claim_error' }), { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    try {
      if (await shouldRetryUnclaimedPaymentIntent(claimRepository, intentId)) {
        console.warn(`[stripe-webhook] intent ${intentId} is still processing — requesting retry`);
        return new Response(JSON.stringify({ error: 'intent_processing' }), { status: 503 });
      }
    } catch (statusErr) {
      console.error(`[stripe-webhook] failed to inspect unclaimed intent ${intentId}:`, statusErr);
      return new Response(JSON.stringify({ error: 'claim_status_error' }), { status: 500 });
    }
    return new Response(JSON.stringify(ACK), { status: 200 });
  }

  // Credit the recipient. amount = NET amount_usd so the RPC's ±5% USD check passes.
  const { error: processError } = await supabase.rpc('process_recharge_payment', {
    p_payment_intent_id: intentId,
    p_webhook_payload: { stripe_session_id: session.id, amount: existingIntent.amount_usd, currency: 'USD', stripe_status: 'paid' },
  });
  if (processError) {
    console.error('[stripe-webhook] process_recharge_payment error:', processError.message);
    try {
      const release = await releasePaymentIntentClaim(
        claimRepository,
        intentId,
        existingIntent.status,
      );
      console.warn(
        `[stripe-webhook] released failed claim for ${intentId}: released=${release.released} retry_status=${release.retryStatus}`,
      );
    } catch (releaseErr) {
      console.error(`[stripe-webhook] failed to release processing claim for ${intentId}:`, releaseErr);
    }
    // 500 → Stripe retries the webhook.
    return new Response(JSON.stringify({ error: 'process_error', detail: processError.message }), { status: 500 });
  }

  // Receipt (fire-and-forget; idempotent on payment_intent_id).
  fetch(`${supabaseUrl}/functions/v1/generate-recharge-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ payment_intent_id: intentId }),
  }).catch((e) => console.error('[stripe-webhook] receipt trigger failed:', e));

  // In-app notification to the recipient (best-effort; never fail the credit).
  try {
    const amount = (existingIntent.amount_cup ?? 0).toLocaleString('es-CU');
    await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({
        user_id: existingIntent.user_id,
        title: 'Recibiste una recarga',
        body: `Te recargaron ${amount} TriciCoin en tu billetera.`,
        category: 'wallet_recharge',
        data: { type: 'wallet_recharge', success: 'true', provider: 'stripe' },
      }),
    });
  } catch (e) {
    console.error('[stripe-webhook] notify failed:', e);
  }

  return new Response(JSON.stringify(ACK), { status: 200 });
});
