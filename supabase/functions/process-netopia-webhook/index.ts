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
//   ⚠️ WPS-01 (audit 2026-06-14): the orderID UUID is NOT a sufficient defense.
//   The legitimate user receives that UUID from create-netopia-payment-intent,
//   so an attacker can create their own intent and forge a paid IPN for it
//   without paying. The atomic claim only stops DOUBLE-crediting one intent, not
//   crediting N self-created intents. The credited amount is server-side
//   (intent.amount_cup), so amount-tampering is blocked — but unverified
//   authenticity = free top-ups. The ONLY real defenses are (a) verify the IPN
//   signature, or (b) re-query NETOPIA's payment status by ntpID with the secret
//   API key, before crediting. Neither is implemented yet.
//   Current mitigations in this handler:
//     1. Atomic claim: status flips pending|created|failed → processing in one
//        UPDATE; a replay sees 0 rows and exits (no double-credit).
//     2. Status checked: only `paid`/`confirmed` credits; others mark failed/refunded.
//     3. LIVE FAIL-CLOSED GUARD (WPS-01): in netopia_environment='live', a paid
//        IPN is REFUSED until IPN_AUTHENTICITY_VERIFIED becomes a real
//        signature/re-query check confirmed in sandbox. Sandbox is unaffected.
//   TODO before live: implement (a) or (b) and set IPN_AUTHENTICITY_VERIFIED.
//
// Contract: docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md §2
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { translateNetopiaError } from '../_shared/netopia-errors.ts';

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
function mapNetopiaStatus(s: number | undefined): 'paid' | 'failed' | 'pending' | 'refunded' | 'unknown' {
  // Per spec: 3=paid, 5=confirmed; 12=invalid account / rejected; 15=3DS required.
  // 4 = refunded/reversed in NETOPIA's v2 spec (admin-initiated from the
  // POS dashboard). If the actual code differs in production we widen
  // this check from the IPN payload — keeping it narrow for now so we
  // don't accidentally drain a wallet on an unexpected status value.
  if (s === 3 || s === 5) return 'paid';
  if (s === 4) return 'refunded';
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
    // `stripe_payment_intent_id` here is NETOPIA's ntpID (column name
    // is legacy from the Stripe era). We need it for the failed→paid
    // recovery check below: if a prior IPN already stamped a different
    // ntpID we treat the second IPN as a separate transaction and
    // refuse the recovery.
    const { data: existingIntent } = await supabase
      .from('payment_intents')
      .select('id, status, user_id, amount_cup, intent_type, corporate_account_id, payment_provider, stripe_payment_intent_id')
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

    // ── 2b. AUTHENTICITY GUARD (WPS-01, audit 2026-06-14) ──
    // This IPN is NOT authenticated: there is no signature/HMAC check and no
    // server-to-server status re-query implemented. The only thing gating a
    // credit is the orderID UUID — but the legitimate user already has that UUID
    // (create-netopia-payment-intent returns it), so an attacker can create their
    // OWN $500 intent and POST a forged {status:3} IPN for it WITHOUT paying →
    // free wallet top-up, unbounded. UUID/ntpID binding does NOT stop this (the
    // attacker owns both for their own intent). The only real defense is verifying
    // authenticity with NETOPIA (verify the IPN signature, OR re-query the payment
    // status by ntpID with the secret API key) — which must be confirmed against
    // sandbox before it can be trusted.
    //
    // Until that verification exists, FAIL CLOSED in the LIVE environment: never
    // credit on an unverified live IPN. Sandbox is unaffected (test freely). Today
    // netopia_environment='sandbox', so this changes nothing now — but it makes it
    // impossible to silently credit forged IPNs if NETOPIA is flipped to live
    // before the verification is implemented. See PAYMENT_PROVIDER_CONTRACT.md §2.
    const IPN_AUTHENTICITY_VERIFIED = false; // TODO(WPS-01): set by a real signature/re-query check, confirmed in sandbox, BEFORE live.
    if (status === 'paid' && !IPN_AUTHENTICITY_VERIFIED) {
      const { data: envCfg } = await supabase
        .from('platform_config').select('value').eq('key', 'netopia_environment').maybeSingle();
      const netopiaEnv = (envCfg?.value as string | undefined) ?? 'sandbox';
      if (netopiaEnv === 'live') {
        console.error(
          `[netopia] CRITICAL (WPS-01): refusing to credit intent ${orderId} — LIVE IPN authenticity is NOT verified ` +
          `(no signature check / no status re-query). Forged-IPN guard. Intent left in its current state for manual ` +
          `reconciliation. Implement NETOPIA IPN verification before enabling live. ip=${clientIP} ntp=${ntpId}`,
        );
        return new Response(
          JSON.stringify({ error: 'ipn_authenticity_unverified', detail: 'Live credit refused pending NETOPIA verification (WPS-01)' }),
          { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    // ── 3. Branch on status ──

    if (status === 'paid') {
      if (existingIntent.status === 'completed') {
        console.log(`[netopia] Intent ${orderId} already completed — replay skipped`);
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // BUG-FIX (2026-05-23, intent d3fc744f): NETOPIA observed sending
      // two IPNs for the same transaction — first an interim status=12
      // ("Invalid CVV"), then ~20s later the final status=3 (paid). The
      // first IPN marks our intent as 'failed'. The second IPN reaches
      // this branch but used to be silently skipped because the atomic
      // claim filter was `.in('status', ['pending', 'created'])` — it
      // refused to recover from 'failed'. Result: card was charged,
      // wallet was NEVER credited.
      //
      // Fix: allow the atomic claim to include 'failed' as a recoverable
      // prior state. Defensive ntpID check: if the prior 'failed' IPN
      // stamped a different ntpID than this paid IPN, we're looking at
      // two distinct NETOPIA transactions on the same orderID, which
      // would be a serious anomaly — refuse the recovery and signal
      // NETOPIA to retry so a human can investigate.
      if (existingIntent.status === 'failed') {
        const priorNtp = existingIntent.stripe_payment_intent_id;
        if (priorNtp && priorNtp !== ntpId) {
          console.error(
            `[netopia] DISCREPANCY: paid IPN for intent ${orderId} ntpID=${ntpId} ` +
            `but prior failed IPN had ntpID=${priorNtp} — refusing to credit, manual review needed`,
          );
          return new Response(
            JSON.stringify({ error: 'ntpid_mismatch_after_failure', detail: 'See logs' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        console.warn(
          `[netopia] Recovering intent ${orderId} from 'failed' → 'paid' ` +
          `(ntpID=${ntpId}) — prior IPN was a non-final status from NETOPIA`,
        );
      }

      // Atomic idempotency claim. Now includes 'failed' as a recoverable
      // state and clears any stale error_message from a prior interim IPN.
      const { data: claimed, error: claimError } = await supabase
        .from('payment_intents')
        .update({
          status: 'processing',
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['pending', 'created', 'failed'])
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
      const providerCode = ipn.payment?.code ?? null;

      // Best-effort update including the new provider_error_code column
      // (migration 00286). If the column doesn't exist yet in this env
      // (pre-migration deploy), retry without it so the webhook still
      // marks the intent failed and notifies the user.
      const { error: updateErr } = await supabase
        .from('payment_intents')
        .update({
          status: 'failed',
          error_message: failReason,
          provider_error_code: providerCode,
          webhook_payload: ipn as unknown as Record<string, unknown>,
          stripe_payment_intent_id: ntpId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['created', 'pending', 'processing']);

      if (updateErr && /provider_error_code|column.*does not exist|schema cache/i.test(updateErr.message)) {
        console.warn(`[netopia] provider_error_code column missing — retrying without it (apply migration 00286): ${updateErr.message}`);
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
      } else if (updateErr) {
        console.error('[netopia] failed-branch update error:', updateErr);
      }

      await sendPaymentNotification(supabase, existingIntent.user_id, existingIntent.amount_cup, false, failReason);

      console.log(`[netopia] Payment failed: ${orderId} — ${failReason} (provider_code=${providerCode ?? 'none'})`);

      return new Response(JSON.stringify(ACK_OK), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (status === 'refunded') {
      // Admin-initiated refund from NETOPIA's POS dashboard. We can only
      // refund what was previously credited — if the intent never
      // completed, there's nothing to reverse.
      if (existingIntent.status !== 'completed') {
        console.warn(
          `[netopia] Refund IPN for non-completed intent ${orderId} (status=${existingIntent.status}) — ignoring`,
        );
        return new Response(JSON.stringify(ACK_OK), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // RPC is idempotent on idempotency_key='recharge_refund_<intent>'.
      // Replays of the same refund IPN are no-ops on the wallet side.
      const refundPayload = {
        netopia_ntp_id: ntpId,
        amount: ipn.payment?.amount,
        currency: ipn.payment?.currency,
        netopia_status: ipn.payment?.status,
        netopia_message: ipn.payment?.message,
      };

      const { error: refundError } = await supabase.rpc('process_recharge_refund', {
        p_payment_intent_id: orderId,
        p_webhook_payload: refundPayload,
      });

      if (refundError) {
        // If the RPC reports already-refunded, ACK and move on. Anything
        // else is an unexpected failure we want to retry by returning 5xx.
        if (/already refunded|idempotency/i.test(refundError.message)) {
          console.log(`[netopia] Refund replay for ${orderId} — already processed`);
          return new Response(JSON.stringify(ACK_OK), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        console.error('[netopia] Refund RPC failed:', refundError);
        return new Response(
          JSON.stringify({ error: 'refund_error', detail: refundError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Stash the webhook payload alongside the existing one — the
      // original 'paid' IPN is preserved by storing the refund under a
      // new column would be cleaner, but we don't have one yet, so we
      // overwrite. Acceptable for now; audit trail lives in the new
      // ledger_transactions row.
      await supabase
        .from('payment_intents')
        .update({
          webhook_payload: ipn as unknown as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      await sendRefundNotification(supabase, existingIntent.user_id, existingIntent.amount_cup);

      console.log(`[netopia] Refund processed for ${orderId}`);

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
 *
 * The optional `failReason` argument is the raw NETOPIA message
 * (e.g. "Invalid CVV"). When present and `success=false`, the push
 * body includes the translated reason so the user knows WHY the
 * payment was rejected without opening the app.
 */
async function sendPaymentNotification(
  _supabase: ReturnType<typeof createClient>,
  userId: string,
  amountCup: number,
  success: boolean,
  failReason?: string | null,
): Promise<void> {
  try {
    const formattedAmount = amountCup.toLocaleString();
    const title = success ? 'Recarga exitosa' : 'Recarga fallida';

    // For failed recharges, surface the translated reason in the push
    // body so the user immediately knows whether it was a CVV issue,
    // insufficient funds, etc. Trim to the first sentence so the body
    // stays under most platform truncation thresholds.
    let body: string;
    if (success) {
      body = `Tu recarga de ${formattedAmount} CUP ha sido acreditada a tu wallet.`;
    } else if (failReason) {
      const friendly = translateNetopiaError(failReason);
      const firstSentence = friendly.split('. ')[0] + (friendly.includes('. ') ? '.' : '');
      body = `Recarga de ${formattedAmount} CUP rechazada: ${firstSentence}`;
    } else {
      body = `Tu recarga de ${formattedAmount} CUP no pudo ser procesada.`;
    }

    // Route through send-push EF so the push gets:
    //   • dead token cleanup (DeviceNotRegistered tickets)
    //   • persistence to the `notifications` inbox table
    //   • category validation against VALID_CATEGORIES
    // Previously we called Expo's API directly and bypassed all three.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        user_id: userId,
        title,
        body,
        category: 'wallet_recharge',
        data: { type: 'wallet_recharge', success: String(success), provider: 'netopia' },
      }),
    });
  } catch (err) {
    console.error('[netopia] Error sending payment notification:', err);
  }
}

/**
 * Send a push notification about a refunded recharge. The wallet has
 * already been debited by `process_recharge_refund` at this point —
 * this is just the user-facing announcement.
 */
async function sendRefundNotification(
  _supabase: ReturnType<typeof createClient>,
  userId: string,
  amountCup: number,
): Promise<void> {
  try {
    const formattedAmount = amountCup.toLocaleString();

    // Route through send-push EF (same reasoning as sendPaymentNotification):
    // dead token cleanup + inbox persistence + category validation.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        user_id: userId,
        title: 'Recarga reembolsada',
        body: `Tu recarga de ${formattedAmount} CUP fue reembolsada. Si tienes dudas, escríbenos a soporte@tricigo.com.`,
        category: 'wallet_recharge_refund',
        data: { type: 'wallet_recharge_refund', provider: 'netopia' },
      }),
    });
  } catch (err) {
    console.error('[netopia] Error sending refund notification:', err);
  }
}
