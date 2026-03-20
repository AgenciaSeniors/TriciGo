// ============================================================
// TriciGo — Process TropiPay Webhook Edge Function
//
// Receives webhook notifications from TropiPay when a payment
// is completed. Validates the payload, calls the DB function
// to credit the user's wallet, and sends a push notification.
//
// Also handles redirect URLs (urlSuccess / urlFailed) by
// checking the ?event query parameter.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CORS: restrict to allowed origins ──
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

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const url = new URL(req.url);
    const event = url.searchParams.get('event');
    const refFromQuery = url.searchParams.get('ref');

    // ─── Handle redirect callbacks (GET from browser redirect) ───
    if (req.method === 'GET' && event && refFromQuery) {
      if (event === 'success') {
        // Find the payment intent by reference
        const { data: intent } = await supabase
          .from('payment_intents')
          .select('id, status, user_id, amount_cup, intent_type, ride_id')
          .eq('tropipay_reference', refFromQuery)
          .single();

        if (intent && intent.status === 'pending') {
          const isRidePayment = intent.intent_type === 'ride_payment';

          if (isRidePayment) {
            // Process ride payment
            await supabase.rpc('process_ride_tropipay_payment', {
              p_payment_intent_id: intent.id,
            });
            await sendRidePaymentNotification(supabase, intent.user_id, intent.amount_cup, intent.ride_id);
          } else {
            // Process wallet recharge
            await supabase.rpc('process_tropipay_payment', {
              p_payment_intent_id: intent.id,
            });
            await sendPaymentNotification(supabase, intent.user_id, intent.amount_cup, true);
          }
        }

        // Redirect to appropriate app deep link
        const intentType = intent?.intent_type ?? 'recharge';
        const redirectUrl = intentType === 'ride_payment' && intent?.ride_id
          ? `tricigo://ride/${intent.ride_id}?payment=success`
          : 'tricigo://wallet?recharge=success';

        return new Response(null, {
          status: 302,
          headers: {
            ...corsHeaders,
            Location: redirectUrl,
          },
        });
      }

      if (event === 'failed') {
        // Find intent to check type
        const { data: failedIntent } = await supabase
          .from('payment_intents')
          .select('intent_type, ride_id')
          .eq('tropipay_reference', refFromQuery)
          .single();

        // Mark intent as failed
        if (refFromQuery) {
          await supabase
            .from('payment_intents')
            .update({ status: 'failed', error_message: 'Payment failed by user', updated_at: new Date().toISOString() })
            .eq('tropipay_reference', refFromQuery)
            .in('status', ['created', 'pending']);

          // If ride payment, also mark ride as failed
          if (failedIntent?.intent_type === 'ride_payment' && failedIntent.ride_id) {
            await supabase
              .from('rides')
              .update({ payment_status: 'failed' })
              .eq('id', failedIntent.ride_id)
              .eq('payment_status', 'pending');
          }
        }

        const redirectUrl = failedIntent?.intent_type === 'ride_payment' && failedIntent?.ride_id
          ? `tricigo://ride/${failedIntent.ride_id}?payment=failed`
          : 'tricigo://wallet?recharge=failed';

        return new Response(null, {
          status: 302,
          headers: {
            ...corsHeaders,
            Location: redirectUrl,
          },
        });
      }
    }

    // ─── Handle webhook POST from TropiPay ───
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Verify TropiPay webhook signature (HMAC-SHA256)
    const webhookSecret = Deno.env.get('TROPIPAY_WEBHOOK_SECRET');
    const rawBody = await req.text();
    let payload: Record<string, unknown>;

    if (webhookSecret) {
      const signature = req.headers.get('x-tropipay-signature')
        ?? req.headers.get('x-webhook-signature')
        ?? '';

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
      const expectedSig = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      if (signature !== expectedSig) {
        console.error('Invalid webhook signature');
        return new Response(
          JSON.stringify({ error: 'Invalid signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    } else {
      console.warn('TROPIPAY_WEBHOOK_SECRET not set — skipping signature verification');
    }

    payload = JSON.parse(rawBody);
    console.log('TropiPay webhook received:', JSON.stringify(payload));

    // TropiPay webhook payload shape:
    // { status, data: { id, reference, amount, currency, state, ... } }
    // or { reference, amount, status, ... } depending on version
    const reference = payload?.data?.reference
      ?? payload?.reference
      ?? payload?.originalCurrencyAmount?.reference
      ?? null;

    if (!reference) {
      console.error('No reference found in webhook payload');
      return new Response(
        JSON.stringify({ ok: false, error: 'no_reference' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Look up payment intent by reference
    const { data: intent, error: lookupError } = await supabase
      .from('payment_intents')
      .select('*')
      .eq('tropipay_reference', reference)
      .single();

    if (lookupError || !intent) {
      console.error('Payment intent not found for reference:', reference);
      return new Response(
        JSON.stringify({ ok: false, error: 'intent_not_found', reference }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Determine if payment was successful from webhook payload
    const webhookStatus = payload?.data?.state ?? payload?.status ?? payload?.state ?? '';
    const isSuccess = ['ACCEPTED', 'OK', 'COMPLETED', 'PAID', '1', 1].includes(webhookStatus)
      || webhookStatus === 'ok'
      || payload?.status === 'OK';

    // Determine intent type: recharge (wallet) or ride_payment (direct)
    const intentType = intent.intent_type ?? 'recharge';

    if (!isSuccess) {
      // Payment was not successful — mark as failed
      await supabase
        .from('payment_intents')
        .update({
          status: 'failed',
          webhook_payload: payload,
          error_message: `TropiPay status: ${webhookStatus}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', intent.id)
        .in('status', ['created', 'pending']);

      // If ride payment, also mark ride payment_status as failed
      if (intentType === 'ride_payment' && intent.ride_id) {
        await supabase
          .from('rides')
          .update({ payment_status: 'failed' })
          .eq('id', intent.ride_id)
          .eq('payment_status', 'pending');
      }

      console.log(`TropiPay payment failed for ${reference}: ${webhookStatus}`);

      return new Response(
        JSON.stringify({ ok: true, action: 'marked_failed' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Payment successful — process based on intent type
    if (intentType === 'ride_payment') {
      // === RIDE PAYMENT ===
      const { data: txnId, error: processError } = await supabase.rpc('process_ride_tropipay_payment', {
        p_payment_intent_id: intent.id,
        p_webhook_payload: payload,
      });

      if (processError) {
        console.error('Error processing TropiPay ride payment:', processError);
        return new Response(
          JSON.stringify({ ok: false, error: 'process_error', detail: processError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      console.log(`TropiPay ride payment processed: ${reference} → txn ${txnId}`);

      // Send push notification to customer and driver
      await sendRidePaymentNotification(supabase, intent.user_id, intent.amount_cup, intent.ride_id);

      return new Response(
        JSON.stringify({ ok: true, transaction_id: txnId, type: 'ride_payment' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    } else {
      // === WALLET RECHARGE ===
      const { data: txnId, error: processError } = await supabase.rpc('process_tropipay_payment', {
        p_payment_intent_id: intent.id,
        p_webhook_payload: payload,
      });

      if (processError) {
        console.error('Error processing TropiPay payment:', processError);
        return new Response(
          JSON.stringify({ ok: false, error: 'process_error', detail: processError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      console.log(`TropiPay payment processed: ${reference} → txn ${txnId}`);

      // Send push notification to user
      await sendPaymentNotification(supabase, intent.user_id, intent.amount_cup, true);

      return new Response(
        JSON.stringify({ ok: true, transaction_id: txnId, type: 'recharge' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
  } catch (err) {
    console.error('Unexpected error in process-tropipay-webhook:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'unexpected', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/**
 * Send a push notification to the user about their payment.
 * Uses the send-push edge function pattern (calls Expo directly).
 */
async function sendPaymentNotification(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  amountCup: number,
  success: boolean,
): Promise<void> {
  try {
    // Fetch user devices
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
    // Non-critical: don't fail the webhook for push notification errors
    console.error('Error sending payment notification:', err);
  }
}

/**
 * Send push notifications for a ride payment confirmation.
 * Notifies both the customer (payment confirmed) and driver (payment received).
 */
async function sendRidePaymentNotification(
  supabase: ReturnType<typeof createClient>,
  customerId: string,
  amountCup: number,
  rideId: string | null,
): Promise<void> {
  try {
    const formattedAmount = amountCup.toLocaleString();

    // Notify customer
    const { data: customerDevices } = await supabase
      .from('user_devices')
      .select('push_token')
      .eq('user_id', customerId)
      .not('push_token', 'is', null);

    const customerTokens = (customerDevices ?? [])
      .map((d: { push_token: string | null }) => d.push_token)
      .filter(Boolean) as string[];

    if (customerTokens.length > 0) {
      const messages = customerTokens.map((token) => ({
        to: token,
        title: 'Pago de viaje confirmado',
        body: `Tu pago de ${formattedAmount} CUP ha sido procesado.`,
        sound: 'default' as const,
        data: { type: 'ride_payment', ride_id: rideId, success: 'true' },
      }));

      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
    }

    // Notify driver (if ride exists)
    if (rideId) {
      const { data: ride } = await supabase
        .from('rides')
        .select('driver_id')
        .eq('id', rideId)
        .single();

      if (ride?.driver_id) {
        const { data: driverProfile } = await supabase
          .from('driver_profiles')
          .select('user_id')
          .eq('id', ride.driver_id)
          .single();

        if (driverProfile?.user_id) {
          const { data: driverDevices } = await supabase
            .from('user_devices')
            .select('push_token')
            .eq('user_id', driverProfile.user_id)
            .not('push_token', 'is', null);

          const driverTokens = (driverDevices ?? [])
            .map((d: { push_token: string | null }) => d.push_token)
            .filter(Boolean) as string[];

          if (driverTokens.length > 0) {
            const driverMessages = driverTokens.map((token) => ({
              to: token,
              title: 'Pago recibido',
              body: `El pasajero ha pagado ${formattedAmount} CUP por el viaje.`,
              sound: 'default' as const,
              data: { type: 'ride_payment_received', ride_id: rideId },
            }));

            await fetch('https://exp.host/--/api/v2/push/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(driverMessages),
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('Error sending ride payment notification:', err);
  }
}
