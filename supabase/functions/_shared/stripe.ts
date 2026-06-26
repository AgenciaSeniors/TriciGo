// Shared Stripe client for Edge Functions (Deno). esm.sh (npm: is unsupported on
// the Edge runtime). Test-mode keys now; live keys swapped in Supabase secrets
// after KYC. Used by create-stripe-recharge-intent + process-stripe-webhook.
import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno';

export function getStripe(): Stripe {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function stripeWebhookSecret(): string {
  const s = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!s) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return s;
}
