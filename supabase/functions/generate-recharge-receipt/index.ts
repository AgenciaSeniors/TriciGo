// ============================================================
// supabase/functions/generate-recharge-receipt/index.ts
//
// Wallet v2 — PR 2/9. Generates the legal PDF receipt for a Stripe
// wallet recharge:
//
//   1. Loads the payment_intent + user.
//   2. Computes USD breakdown (charged, fee 3% min $0.50, net) and
//      CUP equivalent at the exchange-rate snapshot.
//   3. Renders an A4 single-page PDF with pdf-lib (zero native deps,
//      runs cleanly on Deno edge).
//   4. Uploads to private storage bucket `receipts/{user_id}/{TG-...}.pdf`.
//   5. Inserts/updates `wallet_receipts` (UNIQUE on payment_intent_id —
//      idempotent on re-invocation).
//   6. Emails the user + the admin (soporte@tricigo.com) with the PDF
//      attached, via Resend direct.
//
// PR 3 will wire this into `process-stripe-webhook`. For now the
// function is independently invokable for backfill + manual testing.
//
// Spec: docs/WALLET_V2_USD_MODEL.md (sections §3, §4, §10).
// Auth: service_role only (called from webhook + admin retroactive).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1?target=deno';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import {
  walletReceiptHtml,
  walletReceiptSubject,
} from '../_shared/email-templates/index.ts';

// ── Constants from spec §10 ──
const FEE_PCT = 0.03;
const FEE_MIN_USD = 0.50;
const ADMIN_EMAIL_FALLBACK = 'soporte@tricigo.com';
const FROM_EMAIL = 'TriciGo <comprobantes@tricigo.com>';

// Native base64 encode for Uint8Array — avoids dragging in deno_std
// (some versions cause BOOT_ERROR in the Supabase Edge runtime).
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

interface RequestBody {
  payment_intent_id: string;
  /** When true, skip storage upload + emails. Returns the computed
   *  payload and a base64 sample so callers can verify shape. */
  dry_run?: boolean;
}

interface PaymentIntentRow {
  id: string;
  user_id: string;
  amount_usd: number | null;
  amount_cup: number | null;
  exchange_rate: number | null;
  status: string;
  payment_provider: string;
  stripe_payment_intent_id: string | null;
  fee_usd: number | null;
  paid_at: string | null;
  created_at: string;
  card_brand: string | null;
  card_last4: string | null;
}

interface UserRow {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
}

interface ExistingReceipt {
  id: string;
  receipt_no: string;
  pdf_storage_path: string | null;
  email_sent_at_user: string | null;
  email_sent_at_admin: string | null;
}

interface ComputedAmounts {
  usdCharged: number;
  feeUsd: number;
  netUsd: number;
  tcCredited: number;
  exchangeRate: number;
  cupEquivalent: number;
}

// ── HTTP entrypoint ──
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`generate-receipt:${clientIP}`, 30, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // ── Auth gate: service_role only ──
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const apiKey = req.headers.get('apikey') ?? '';
    if (apiKey !== serviceRoleKey) {
      return jsonResponse({ error: 'Forbidden: internal-only' }, 403);
    }

    const body = (await req.json()) as RequestBody;
    if (!body.payment_intent_id) {
      return jsonResponse({ error: 'payment_intent_id required' }, 400);
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);

    // 1. Load payment_intent + user
    const { data: pi, error: piErr } = await supabase
      .from('payment_intents')
      .select(
        'id, user_id, amount_usd, amount_cup, exchange_rate, status, ' +
        'payment_provider, stripe_payment_intent_id, fee_usd, paid_at, created_at, ' +
        'card_brand, card_last4',
      )
      .eq('id', body.payment_intent_id)
      .single();
    if (piErr) throw piErr;
    if (!pi) return jsonResponse({ error: 'payment_intent_not_found' }, 404);

    const piRow = pi as PaymentIntentRow;
    if (piRow.payment_provider !== 'stripe') {
      return jsonResponse({ error: 'not_stripe_recharge', provider: piRow.payment_provider }, 400);
    }
    if (piRow.status !== 'completed' && piRow.status !== 'succeeded') {
      return jsonResponse({ error: 'payment_not_completed', status: piRow.status }, 400);
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('id, full_name, email, phone')
      .eq('id', piRow.user_id)
      .single();
    if (userErr) throw userErr;
    const userRow = user as UserRow;

    // 2. Idempotency check — reuse existing receipt_no if any
    const { data: existing } = await supabase
      .from('wallet_receipts')
      .select('id, receipt_no, pdf_storage_path, email_sent_at_user, email_sent_at_admin')
      .eq('payment_intent_id', body.payment_intent_id)
      .maybeSingle();
    const existingRow = existing as ExistingReceipt | null;

    // 3. Compute USD/CUP breakdown
    const amounts = computeAmounts(piRow);

    // 4. Resolve receipt_no (reuse if reprocessing)
    let receiptNo: string;
    if (existingRow?.receipt_no) {
      receiptNo = existingRow.receipt_no;
    } else {
      const { data: rn, error: rnErr } = await supabase.rpc('generate_receipt_no');
      if (rnErr) throw rnErr;
      receiptNo = rn as string;
    }

    // 5. Build PDF
    const dateISO = piRow.paid_at ?? piRow.created_at;
    const pdfBytes = await buildReceiptPdf({
      receiptNo,
      user: userRow,
      amounts,
      stripePaymentIntentId: piRow.stripe_payment_intent_id ?? '',
      cardBrand: piRow.card_brand,
      cardLast4: piRow.card_last4,
      dateISO,
    });

    if (body.dry_run) {
      return jsonResponse({
        dry_run: true,
        receipt_no: receiptNo,
        amounts,
        pdf_size_bytes: pdfBytes.byteLength,
        pdf_base64_first_120: encodeBase64(pdfBytes.slice(0, 120)),
        user_email: userRow.email,
      });
    }

    // 6. Upload to storage (upsert so re-runs replace any prior PDF)
    const storagePath = `${piRow.user_id}/${receiptNo}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('receipts')
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw new Error(`storage_upload_failed: ${uploadErr.message}`);

    // 7. Insert or update wallet_receipts row
    const receiptRow = {
      user_id: piRow.user_id,
      payment_intent_id: piRow.id,
      receipt_no: receiptNo,
      usd_charged: amounts.usdCharged.toFixed(2),
      fee_usd: amounts.feeUsd.toFixed(2),
      net_usd: amounts.netUsd.toFixed(2),
      tc_credited: amounts.tcCredited.toFixed(2),
      exchange_rate: amounts.exchangeRate.toFixed(2),
      exchange_at: dateISO,
      cup_equivalent: amounts.cupEquivalent.toFixed(2),
      stripe_payment_intent_id: piRow.stripe_payment_intent_id ?? '',
      card_brand: piRow.card_brand,
      card_last4: piRow.card_last4,
      pdf_storage_path: storagePath,
      pdf_generated_at: new Date().toISOString(),
    };
    if (existingRow) {
      const { error } = await supabase
        .from('wallet_receipts')
        .update(receiptRow)
        .eq('id', existingRow.id);
      if (error) throw new Error(`receipt_update_failed: ${error.message}`);
    } else {
      const { error } = await supabase.from('wallet_receipts').insert(receiptRow);
      if (error) throw new Error(`receipt_insert_failed: ${error.message}`);
    }

    // 8. Email user + admin (Resend direct — send-email EF doesn't support attachments)
    const pdfBase64 = encodeBase64(pdfBytes);
    const adminEmail = Deno.env.get('ADMIN_RECEIPT_EMAIL') ?? ADMIN_EMAIL_FALLBACK;

    const dateLabel = formatDate(dateISO);

    const userEmailResult = userRow.email && !existingRow?.email_sent_at_user
      ? await sendResend({
          to: userRow.email,
          subject: walletReceiptSubject(receiptNo, 'user'),
          html: walletReceiptHtml({
            audience: 'user',
            receiptNo,
            dateLabel,
            user: { full_name: userRow.full_name, email: userRow.email, id: userRow.id },
            amounts,
          }),
          attachmentBase64: pdfBase64,
          attachmentFilename: `${receiptNo}.pdf`,
        })
      : { skipped: true };

    const adminEmailResult = !existingRow?.email_sent_at_admin
      ? await sendResend({
          to: adminEmail,
          subject: `${walletReceiptSubject(receiptNo, 'admin')} — $${amounts.usdCharged.toFixed(2)} USD`,
          html: walletReceiptHtml({
            audience: 'admin',
            receiptNo,
            dateLabel,
            user: { full_name: userRow.full_name, email: userRow.email, id: userRow.id },
            amounts,
            stripePaymentIntentId: piRow.stripe_payment_intent_id,
          }),
          attachmentBase64: pdfBase64,
          attachmentFilename: `${receiptNo}.pdf`,
        })
      : { skipped: true };

    // 9. Update timestamps
    const stampUpdate: Record<string, string> = {};
    if (userEmailResult && !('skipped' in userEmailResult) && (userEmailResult as { ok: boolean }).ok) {
      stampUpdate.email_sent_at_user = new Date().toISOString();
    }
    if (adminEmailResult && !('skipped' in adminEmailResult) && (adminEmailResult as { ok: boolean }).ok) {
      stampUpdate.email_sent_at_admin = new Date().toISOString();
    }
    if (Object.keys(stampUpdate).length > 0) {
      await supabase.from('wallet_receipts').update(stampUpdate).eq('payment_intent_id', piRow.id);
    }

    return jsonResponse({
      ok: true,
      receipt_no: receiptNo,
      storage_path: storagePath,
      amounts,
      user_email: userEmailResult,
      admin_email: adminEmailResult,
    });
  } catch (err) {
    console.error('[generate-recharge-receipt] failed:', err);
    return jsonResponse({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

// ── Helpers ──

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function computeAmounts(pi: PaymentIntentRow): ComputedAmounts {
  const usdCharged = Number(pi.amount_usd ?? 0);
  const exchangeRate = Number(pi.exchange_rate ?? 0);
  // Spec §10 #2: 3% of USD charged, minimum $0.50.
  // Prefer the fee_usd already snapshotted on the PI (set by Stripe webhook)
  // to avoid drift if the constant changes later.
  const feeUsd = pi.fee_usd != null && Number(pi.fee_usd) > 0
    ? Number(pi.fee_usd)
    : Math.max(usdCharged * FEE_PCT, FEE_MIN_USD);
  const netUsd = Math.max(0, usdCharged - feeUsd);
  // Spec §1: 1 TriciCoin ≡ 1 USD.
  const tcCredited = netUsd;
  const cupEquivalent = exchangeRate > 0 ? netUsd * exchangeRate : 0;
  return { usdCharged, feeUsd, netUsd, tcCredited, exchangeRate, cupEquivalent };
}

interface PdfArgs {
  receiptNo: string;
  user: UserRow;
  amounts: ComputedAmounts;
  stripePaymentIntentId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  dateISO: string;
}

async function buildReceiptPdf(args: PdfArgs): Promise<Uint8Array> {
  const { receiptNo, user, amounts, stripePaymentIntentId, cardBrand, cardLast4, dateISO } = args;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4 in points
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const orange = rgb(0.97, 0.45, 0.09);
  const ink = rgb(0.10, 0.10, 0.10);
  const muted = rgb(0.42, 0.42, 0.42);

  let y = 790;
  const left = 50;
  const right = 545;

  // Header
  page.drawText('TriciGo', { x: left, y, size: 26, font: helvBold, color: orange });
  page.drawText(receiptNo, { x: right - helv.widthOfTextAtSize(receiptNo, 11), y: y + 4, size: 11, font: helvBold, color: ink });
  y -= 14;
  page.drawText('Comprobante de recarga · Wallet TriciCoin', { x: left, y, size: 10, font: helv, color: muted });
  y -= 30;

  // Title underline
  page.drawText('COMPROBANTE DE RECARGA', { x: left, y, size: 13, font: helvBold, color: ink });
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1.5, color: orange });
  y -= 22;

  // User info block
  const dateStr = formatDate(dateISO);
  drawRow(page, helv, 'Fecha', dateStr, left, right, y, ink, muted); y -= 18;
  if (user.full_name) { drawRow(page, helv, 'Usuario', user.full_name, left, right, y, ink, muted); y -= 18; }
  drawRow(page, helv, 'ID usuario', user.id, left, right, y, ink, muted); y -= 18;
  if (user.email) { drawRow(page, helv, 'Email', user.email, left, right, y, ink, muted); y -= 18; }
  if (user.phone) { drawRow(page, helv, 'Teléfono', user.phone, left, right, y, ink, muted); y -= 18; }
  y -= 14;

  // Amounts block
  page.drawText('Detalle:', { x: left, y, size: 11, font: helvBold, color: ink });
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: left + 50, y }, thickness: 1, color: ink });
  y -= 18;

  drawRow(page, helv, 'Importe cobrado USD', `$${amounts.usdCharged.toFixed(2)}`, left, right, y, ink, muted); y -= 16;
  drawRow(page, helv, `Comisión de servicio`, `-$${amounts.feeUsd.toFixed(2)}`, left, right, y, ink, muted); y -= 16;
  drawRow(page, helv, 'Importe neto acreditado', `$${amounts.netUsd.toFixed(2)}`, left, right, y, ink, muted, helvBold); y -= 16;
  drawRow(page, helv, 'TriciCoin acreditados (1 TC = 1 USD)', `${amounts.tcCredited.toFixed(2)} TC`, left, right, y, ink, muted, helvBold); y -= 22;

  // CUP equivalence
  page.drawText('Equivalencia CUP (informativa):', { x: left, y, size: 10, font: helvBold, color: ink });
  y -= 16;
  if (amounts.exchangeRate > 0) {
    drawRow(page, helv, 'Tasa USD/CUP del día', amounts.exchangeRate.toFixed(2), left, right, y, ink, muted); y -= 16;
    drawRow(page, helv, 'Equivalente en CUP', formatCup(amounts.cupEquivalent), left, right, y, ink, muted); y -= 22;
  } else {
    page.drawText('Tasa de cambio no disponible al momento de la recarga.', { x: left, y, size: 9, font: helv, color: muted });
    y -= 22;
  }

  // Payment method (card brand + last4 will be wired in PR 3)
  page.drawText('Método de pago:', { x: left, y, size: 10, font: helvBold, color: ink });
  y -= 16;
  const cardLine = cardBrand && cardLast4
    ? `${capitalize(cardBrand)} terminada en •••• ${cardLast4}`
    : cardBrand
      ? `${capitalize(cardBrand)} (Stripe)`
      : 'Tarjeta de crédito/débito (Stripe)';
  page.drawText(cardLine, { x: left, y, size: 10, font: helv, color: ink });
  y -= 14;
  if (stripePaymentIntentId) {
    page.drawText(`Stripe PaymentIntent: ${stripePaymentIntentId}`, { x: left, y, size: 8, font: helv, color: muted });
    y -= 18;
  }

  // Footer disclaimer
  y = 110;
  page.drawLine({ start: { x: left, y: y + 10 }, end: { x: right, y: y + 10 }, thickness: 0.5, color: muted });
  page.drawText('Este comprobante se emite a efectos contables. La equivalencia en CUP es', {
    x: left, y, size: 8, font: helv, color: muted,
  });
  y -= 11;
  page.drawText('referencial al momento de la transacción y puede variar al gastar.', {
    x: left, y, size: 8, font: helv, color: muted,
  });
  y -= 22;
  page.drawText('TriciGo · Cuba · contacto@tricigo.com', {
    x: left, y, size: 8, font: helvBold, color: ink,
  });

  return pdf.save();
}

function drawRow(
  page: ReturnType<PDFDocument['addPage']>,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  label: string,
  value: string,
  left: number,
  right: number,
  y: number,
  ink: ReturnType<typeof rgb>,
  muted: ReturnType<typeof rgb>,
  valueFont?: Awaited<ReturnType<PDFDocument['embedFont']>>,
) {
  page.drawText(label, { x: left, y, size: 10, font, color: muted });
  const vFont = valueFont ?? font;
  const w = vFont.widthOfTextAtSize(value, 10);
  page.drawText(value, { x: right - w, y, size: 10, font: vFont, color: ink });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CU', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Havana',
  });
}

function formatCup(cup: number): string {
  return new Intl.NumberFormat('es-CU', { maximumFractionDigits: 2 }).format(cup) + ' CUP';
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ── Email rendering moved to ../_shared/email-templates/wallet_receipt.ts ──
// (was inline buildUserEmailHtml / buildAdminEmailHtml — superseded by the
// branded templates so all transactional emails share the same wrapper.)

// ── Resend direct (with attachment support) ──

interface ResendArgs {
  to: string;
  subject: string;
  html: string;
  attachmentBase64: string;
  attachmentFilename: string;
}

async function sendResend(args: ResendArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return { ok: false, error: 'resend_not_configured' };

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: args.to,
      subject: args.subject,
      html: args.html,
      attachments: [{ filename: args.attachmentFilename, content: args.attachmentBase64 }],
    }),
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.warn('[generate-recharge-receipt] Resend send failed:', json);
    return { ok: false, error: typeof json === 'object' && json !== null ? (json as { message?: string }).message ?? 'send_failed' : 'send_failed' };
  }
  return { ok: true, id: (json as { id?: string }).id };
}
