// ============================================================
// TriciGo — NETOPIA error translation (Edge Function mirror)
//
// DUPLICATE of `packages/utils/src/netopia-errors.ts`. Edge Functions
// run on Deno and don't import the `@tricigo/utils` package (which
// is TypeScript/Node). Both copies share the same dataset (5 entries
// at the time of writing) — when adding/changing entries, update
// BOTH files to keep frontend (toast) and backend (push body)
// consistent.
//
// Used by: process-netopia-webhook/index.ts → sendPaymentNotification
//
// Origin: bug investigation of intent d3fc744f (2026-05-23). Plan:
// ~/.claude/plans/rol-eres-un-auditor-immutable-platypus.md
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

export function translateNetopiaError(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) {
    return 'El procesador rechazó el pago. Tu tarjeta NO fue cobrada — reintentá o usá otra tarjeta.';
  }
  return NETOPIA_ERROR_MAP[raw] ?? `${raw}. Tu tarjeta NO fue cobrada.`;
}
