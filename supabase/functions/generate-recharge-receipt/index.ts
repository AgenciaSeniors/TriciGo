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
import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1?target=deno';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import {
  BRAND_NAME,
  BRAND_RGB,
  LOGO_URL,
  SUPPORT_EMAIL,
  WEB_ORIGIN,
} from '../_shared/brand.ts';
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

    const dateLabel = formatDateLong(dateISO);

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

  // Brand palette — same source of truth as the email templates so
  // PDF and email feel like one product.
  const primary = rgb(...BRAND_RGB.primary);
  const primaryLight = rgb(...BRAND_RGB.primaryLight);
  const ink = rgb(...BRAND_RGB.ink);
  const text = rgb(...BRAND_RGB.text);
  const muted = rgb(...BRAND_RGB.muted);
  const border = rgb(...BRAND_RGB.border);

  const left = 50;
  const right = 545;
  const pageWidth = 595.28;

  // ── Header band: white bg, logo left + receipt-number chip right.
  // Logo is fetched at runtime; if the URL fails we fall back to a
  // wordmark in primary color so the PDF never breaks because of a
  // network hiccup.
  let y = 790;
  const logo = await tryEmbedLogo(pdf);
  if (logo) {
    const targetH = 28;
    const w = (logo.width / logo.height) * targetH;
    page.drawImage(logo, { x: left, y: y - 4, width: w, height: targetH });
  } else {
    page.drawText(BRAND_NAME, { x: left, y, size: 24, font: helvBold, color: primary });
  }
  // Receipt-number chip — right side, soft orange background.
  drawChip(page, helv, helvBold, receiptNo, right, y - 4, primary, primaryLight);
  y -= 18;
  page.drawText('Comprobante de recarga · Wallet TriciCoin', {
    x: left, y, size: 9, font: helv, color: muted,
  });
  y -= 24;

  // ── Hero block: orange band with the credited amount in big type.
  // Anchors the rider's eye on what they got, not on what they paid.
  const heroH = 64;
  page.drawRectangle({ x: 0, y: y - heroH, width: pageWidth, height: heroH, color: primary });
  page.drawText('RECARGA CONFIRMADA', {
    x: left, y: y - 22, size: 10, font: helvBold, color: rgb(1, 1, 1),
  });
  const tcLabel = `${amounts.tcCredited.toFixed(2)} TriciCoin acreditados`;
  page.drawText(tcLabel, {
    x: left, y: y - 46, size: 18, font: helvBold, color: rgb(1, 1, 1),
  });
  y -= heroH + 28;

  // ── Section 1: rider details ───────────────────────────────────
  y = drawSectionHeader(page, helvBold, 'Datos del usuario', left, y, ink, primary);
  y = drawRow(page, helv, helvBold, 'Fecha', formatDateLong(dateISO), left, right, y, text, muted);
  if (user.full_name) {
    y = drawRow(page, helv, helvBold, 'Nombre', user.full_name, left, right, y, text, muted);
  }
  y = drawRow(page, helv, helvBold, 'ID usuario', user.id, left, right, y, muted, muted);
  if (user.email) {
    y = drawRow(page, helv, helvBold, 'Email', user.email, left, right, y, text, muted);
  }
  if (user.phone) {
    y = drawRow(page, helv, helvBold, 'Teléfono', user.phone, left, right, y, text, muted);
  }
  y -= 18;

  // ── Section 2: transaction breakdown ───────────────────────────
  y = drawSectionHeader(page, helvBold, 'Detalle de la transacción', left, y, ink, primary);
  y = drawRow(page, helv, helvBold, 'Importe cobrado', fmtUsd(amounts.usdCharged), left, right, y, text, muted);
  y = drawRow(page, helv, helvBold, 'Comisión de servicio', `−${fmtUsd(amounts.feeUsd)}`, left, right, y, text, muted);
  y = drawRow(page, helv, helvBold, 'Importe neto acreditado', fmtUsd(amounts.netUsd), left, right, y, ink, muted, true);
  y = drawTotalRow(page, helvBold, 'TriciCoin acreditados', `${amounts.tcCredited.toFixed(2)} TC`, left, right, y, primary, ink);
  y = drawHelperLine(page, helv, '1 TriciCoin = 1 USD', left, y, muted);
  y -= 16;

  // ── Section 3: CUP conversion (only if rate snapshotted) ───────
  y = drawSectionHeader(page, helvBold, 'Conversión a CUP (referencial)', left, y, ink, primary);
  if (amounts.exchangeRate > 0) {
    y = drawRow(page, helv, helvBold, 'Tasa USD → CUP del día', amounts.exchangeRate.toFixed(2), left, right, y, text, muted);
    y = drawRow(page, helv, helvBold, 'Equivalente en CUP', formatCup(amounts.cupEquivalent), left, right, y, text, muted);
  } else {
    y = drawHelperLine(page, helv, 'Tasa de cambio no disponible al momento de la recarga.', left, y, muted);
  }
  y -= 18;

  // ── Section 4: payment method ──────────────────────────────────
  y = drawSectionHeader(page, helvBold, 'Método de pago', left, y, ink, primary);
  const cardLine = cardBrand && cardLast4
    ? `${capitalize(cardBrand)} terminada en •••• ${cardLast4}`
    : cardBrand
      ? `${capitalize(cardBrand)} (Stripe)`
      : 'Tarjeta de crédito/débito (vía Stripe)';
  page.drawText(cardLine, { x: left, y, size: 10, font: helv, color: text });
  y -= 14;
  if (stripePaymentIntentId) {
    page.drawText(`Referencia Stripe: ${stripePaymentIntentId}`, {
      x: left, y, size: 8, font: helv, color: muted,
    });
  }

  // ── Footer: disclaimer + tagline + contact ─────────────────────
  const footerY = 90;
  page.drawLine({
    start: { x: left, y: footerY + 38 },
    end: { x: right, y: footerY + 38 },
    thickness: 0.5,
    color: border,
  });
  page.drawText(
    'Este comprobante se emite a efectos contables. La equivalencia en CUP es',
    { x: left, y: footerY + 24, size: 8, font: helv, color: muted },
  );
  page.drawText(
    'referencial al momento de la transacción y puede variar al gastar.',
    { x: left, y: footerY + 14, size: 8, font: helv, color: muted },
  );
  page.drawText(`${BRAND_NAME} · Cuba · ${SUPPORT_EMAIL}`, {
    x: left, y: footerY - 4, size: 8, font: helvBold, color: ink,
  });
  // Web origin right-aligned on the same baseline.
  const webText = WEB_ORIGIN.replace(/^https?:\/\//, '');
  const webW = helv.widthOfTextAtSize(webText, 8);
  page.drawText(webText, {
    x: right - webW, y: footerY - 4, size: 8, font: helv, color: muted,
  });

  return pdf.save();
}

// ── PDF helpers ─────────────────────────────────────────────────

const ROW_HEIGHT = 18;

function drawSectionHeader(
  page: PDFPage,
  fontBold: PDFFont,
  title: string,
  left: number,
  y: number,
  ink: ReturnType<typeof rgb>,
  primary: ReturnType<typeof rgb>,
): number {
  page.drawText(title, { x: left, y, size: 11, font: fontBold, color: ink });
  // Short orange underline — visual anchor for each section without
  // pulling focus from the row data below.
  page.drawLine({
    start: { x: left, y: y - 4 },
    end: { x: left + 36, y: y - 4 },
    thickness: 1.5,
    color: primary,
  });
  return y - 22;
}

function drawRow(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  label: string,
  value: string,
  left: number,
  right: number,
  y: number,
  textColor: ReturnType<typeof rgb>,
  muted: ReturnType<typeof rgb>,
  emphasize = false,
): number {
  page.drawText(label, { x: left, y, size: 10, font, color: muted });
  const vFont = emphasize ? fontBold : font;
  const w = vFont.widthOfTextAtSize(value, 10);
  page.drawText(value, { x: right - w, y, size: 10, font: vFont, color: textColor });
  return y - ROW_HEIGHT;
}

function drawTotalRow(
  page: PDFPage,
  fontBold: PDFFont,
  label: string,
  value: string,
  left: number,
  right: number,
  y: number,
  primary: ReturnType<typeof rgb>,
  ink: ReturnType<typeof rgb>,
): number {
  page.drawText(label, { x: left, y, size: 11, font: fontBold, color: ink });
  const w = fontBold.widthOfTextAtSize(value, 14);
  page.drawText(value, { x: right - w, y: y - 1, size: 14, font: fontBold, color: primary });
  return y - 20;
}

function drawHelperLine(
  page: PDFPage,
  font: PDFFont,
  text: string,
  left: number,
  y: number,
  muted: ReturnType<typeof rgb>,
): number {
  page.drawText(text, { x: left, y, size: 8, font, color: muted });
  return y - 14;
}

function drawChip(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  label: string,
  rightX: number,
  y: number,
  primary: ReturnType<typeof rgb>,
  primaryLight: ReturnType<typeof rgb>,
): void {
  const padX = 10;
  const w = fontBold.widthOfTextAtSize(label, 10) + padX * 2;
  const h = 22;
  const x = rightX - w;
  page.drawRectangle({ x, y, width: w, height: h, color: primaryLight });
  page.drawRectangle({ x, y, width: w, height: h, borderColor: primary, borderWidth: 0.5 });
  page.drawText(label, {
    x: x + padX,
    y: y + 7,
    size: 10,
    font: fontBold,
    color: primary,
  });
}

// Network-fetch the brand logo and embed as a pdf-lib image. Cached
// per process — Supabase EFs reuse the runtime across invocations
// so the logo bytes only travel the wire once per cold start. Any
// failure (network, 404, decoding) returns null so the caller can
// fall back to the wordmark text.
let cachedLogoBytes: Uint8Array | null | undefined;
async function tryEmbedLogo(pdf: PDFDocument): Promise<PDFImage | null> {
  if (cachedLogoBytes === null) return null; // negative cache
  if (cachedLogoBytes === undefined) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(LOGO_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        cachedLogoBytes = null;
        return null;
      }
      cachedLogoBytes = new Uint8Array(await res.arrayBuffer());
    } catch (_err) {
      cachedLogoBytes = null;
      return null;
    }
  }
  try {
    return await pdf.embedPng(cachedLogoBytes);
  } catch (_err) {
    cachedLogoBytes = null;
    return null;
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)} USD`;
}

const WEEKDAY_ES: Record<number, string> = {
  0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles',
  4: 'Jueves', 5: 'Viernes', 6: 'Sábado',
};

function formatDateLong(iso: string): string {
  const d = new Date(iso);
  // We want "Domingo 11 de mayo de 2026, 14:30 (Cuba)" — the native
  // toLocaleDateString lowercases the weekday and lacks the locale
  // suffix. Stitch the parts manually to guarantee output stability
  // across Deno/V8 minor versions (which have shifted "es-CU" output
  // before).
  const havanaDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/Havana' }));
  const weekday = WEEKDAY_ES[havanaDate.getDay()] ?? '';
  const datePart = d.toLocaleDateString('es-CU', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'America/Havana',
  });
  const timePart = d.toLocaleTimeString('es-CU', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Havana',
  });
  return `${weekday} ${datePart}, ${timePart} (Cuba)`;
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
