// ============================================================
// TriciGo — NETOPIA error message translation
//
// NETOPIA returns failure messages in English (e.g. "Invalid CVV",
// "Insufficient funds"). We map known messages to user-friendly
// Spanish copy that always tells the user explicitly that their
// card was NOT charged (true for `payment_intents.status='failed'`).
//
// Used by:
//   - apps/driver/app/wallet/recharge.tsx (toast on failed recharge)
//   - apps/client/app/(tabs)/wallet.tsx (toast on failed recharge)
//
// Mirrored by:
//   - supabase/functions/_shared/netopia-errors.ts (push notification body)
//
// Keep the two in sync — they share the same dataset. Duplication
// is intentional: EFs run on Deno and don't import @tricigo/utils.
//
// Origin: bug investigation of intent d3fc744f (2026-05-23, NETOPIA
// two-IPN edge case). Plan: ~/.claude/plans/rol-eres-un-auditor-immutable-platypus.md
// ============================================================

const NETOPIA_ERROR_MAP: Record<string, string> = {
  'Invalid CVV':
    'El código de seguridad (CVV) no fue validado por tu banco. Tu tarjeta NO fue cobrada — verificá el CVV y reintentá.',
  'Insufficient funds':
    'Saldo insuficiente en tu tarjeta. Tu tarjeta NO fue cobrada.',
  'Card declined':
    'Tu banco rechazó la transacción. Tu tarjeta NO fue cobrada — contactá a tu banco si el rechazo es inesperado.',
  'Expired card':
    'Tu tarjeta está vencida. Tu tarjeta NO fue cobrada.',
  '3DS authentication failed':
    'La verificación 3D-Secure (OTP) falló. Tu tarjeta NO fue cobrada — reintentá con el código correcto.',
};

/**
 * Translate a NETOPIA failure message into Spanish, always making
 * clear that the card was NOT charged (the invariant for IPNs that
 * map to `payment_intents.status='failed'`).
 *
 * - Known messages from the map: full Spanish copy with context.
 * - Unknown messages: original text + "Tu tarjeta NO fue cobrada."
 * - null / undefined / empty: generic fallback.
 *
 * The function never throws and never returns an empty string —
 * always returns a user-displayable Spanish string.
 */
export function translateNetopiaError(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) {
    return 'El procesador rechazó el pago. Tu tarjeta NO fue cobrada — reintentá o usá otra tarjeta.';
  }
  return NETOPIA_ERROR_MAP[raw] ?? `${raw}. Tu tarjeta NO fue cobrada.`;
}
