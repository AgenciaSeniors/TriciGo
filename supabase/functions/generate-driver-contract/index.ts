// ============================================================
// supabase/functions/generate-driver-contract/index.ts
//
// Generates the driver T&C-acceptance contract when a driver
// completes onboarding (driver_profiles.status -> 'under_review',
// trigger trg_generate_driver_contract from migration 00405):
//
//   1. Loads driver_profiles + users + active vehicle.
//   2. Loads the LIVE Terms & Conditions (cms_content 'terms') so the
//      Spanish PDF embeds exactly the version the driver accepted.
//   3. Renders TWO A4 PDFs with pdf-lib: Spanish (driver + admin) and
//      Romanian (admin only — MACH DIGITAL TECH S.R.L. is Romanian).
//      Cover: parties, driver + vehicle data, acceptance declaration.
//      Annex I: the full T&C text, word-wrapped + paginated.
//   4. Uploads both to the private bucket driver-contracts/
//      {user_id}/{CTR-...}-es|ro.pdf (upsert).
//   5. Upserts driver_contracts (UNIQUE driver_id — idempotent).
//   6. Emails the driver (Spanish PDF) and administration (both PDFs,
//      ADMIN_CONTRACT_EMAIL or soporte@tricigo.com) via Resend direct.
//
// Auth (verify_jwt=false at the gateway, own auth inside):
//   - service_role key (DB trigger via vault) — full access; OR
//   - a logged-in admin/super_admin JWT (the admin panel's
//     "Generar contrato" button calls functions.invoke directly).
//
// Fonts: pdf-lib StandardFonts are WinAnsi-encoded and CANNOT encode
// Romanian ș/ț/ă — we fetch DejaVu Sans (Unicode TTF) at runtime
// (cached per process, like the logo in generate-recharge-receipt)
// and embed subsetted via @pdf-lib/fontkit. If the fetch fails we
// fall back to Helvetica + diacritic-stripped text so contract
// generation NEVER fails because of a font CDN hiccup.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  rgb,
  StandardFonts,
} from 'https://esm.sh/pdf-lib@1.17.1?target=deno';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1?target=deno';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { BRAND_NAME, BRAND_RGB, LOGO_URL } from '../_shared/brand.ts';
import {
  CONTRACT_ES,
  CONTRACT_RO,
  ContractBlock,
  ContractCopy,
  TERMS_RO_BODY,
  TERMS_RO_TITLE,
} from '../_shared/driver-contract.ts';
import { CONTRACT_STAMP_PNG_BASE64 } from '../_shared/contract-stamp.ts';
import {
  driverContractHtml,
  driverContractSubject,
} from '../_shared/email-templates/driver_contract.ts';

const ADMIN_EMAIL_FALLBACK = 'soporte@tricigo.com';
const FROM_EMAIL = 'TriciGo <contratos@tricigo.com>';
const BUCKET = 'driver-contracts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

// DejaVu Sans: full Latin coverage incl. Romanian ș/ț/ă. Overridable
// so we can point at a self-hosted copy without redeploying.
const FONT_REGULAR_URL =
  Deno.env.get('CONTRACT_FONT_URL') ??
  'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const FONT_BOLD_URL =
  Deno.env.get('CONTRACT_FONT_BOLD_URL') ??
  'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf';

// ── Small helpers ────────────────────────────────────────────────

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function jsonResponse(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// Native base64 for Uint8Array (same as generate-recharge-receipt —
// deno_std's encoder caused BOOT_ERROR on some runtime versions).
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

interface RequestBody {
  driver_id: string;
  /** Regenerate + re-send even if a contract already exists (admin button). */
  force?: boolean;
}

interface DriverProfileRow {
  id: string;
  user_id: string;
  status: string;
  terms_accepted_at: string | null;
  identity_number: string | null;
  address: string | null;
  province: string | null;
  municipality: string | null;
  created_at: string;
}

interface UserRow {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
}

interface VehicleRow {
  type: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate_number: string | null;
  capacity: number | null;
}

interface ExistingContract {
  id: string;
  contract_no: string;
  accepted_at: string;
  pdf_es_path: string | null;
  pdf_ro_path: string | null;
  emailed_driver_at: string | null;
  emailed_admin_at: string | null;
}

// ── HTTP entrypoint ──────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) });
  if (req.method !== 'POST') return jsonResponse(req, { error: 'method_not_allowed' }, 405);

  try {
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`gen-contract:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Auth: service_role (trigger) OR admin user JWT (admin panel) ──
    const apiKeyHeader = req.headers.get('apikey') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const isInternal = apiKeyHeader === serviceRoleKey || bearer === serviceRoleKey;

    if (!isInternal) {
      if (!bearer) return jsonResponse(req, { error: 'unauthorized' }, 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) return jsonResponse(req, { error: 'unauthorized' }, 401);
      const { data: roleRow } = await admin
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();
      const role = (roleRow as { role?: string } | null)?.role ?? '';
      if (role !== 'admin' && role !== 'super_admin') {
        return jsonResponse(req, { error: 'forbidden_admin_only' }, 403);
      }
    }

    const body = (await req.json()) as RequestBody;
    if (!body.driver_id) return jsonResponse(req, { error: 'driver_id required' }, 400);

    // ── 1. Load driver + user + vehicle ──
    const { data: dp, error: dpErr } = await admin
      .from('driver_profiles')
      .select('id, user_id, status, terms_accepted_at, identity_number, address, province, municipality, created_at')
      .eq('id', body.driver_id)
      .single();
    if (dpErr || !dp) return jsonResponse(req, { error: 'driver_not_found' }, 404);
    const driver = dp as DriverProfileRow;

    const { data: u, error: uErr } = await admin
      .from('users')
      .select('id, full_name, email, phone')
      .eq('id', driver.user_id)
      .single();
    if (uErr || !u) return jsonResponse(req, { error: 'user_not_found' }, 404);
    const user = u as UserRow;

    // Driver email: prefer public.users.email, fall back to auth.users
    // (phone-signup drivers often only have it there — same pattern as
    // generate-recharge-receipt).
    let driverEmail: string | null = user.email ?? null;
    if (!driverEmail) {
      const { data: authUser } = await admin.auth.admin.getUserById(driver.user_id);
      driverEmail = authUser?.user?.email ?? null;
    }

    const { data: vehicles } = await admin
      .from('vehicles')
      .select('type, make, model, year, color, plate_number, capacity')
      .eq('driver_id', driver.id)
      .eq('is_active', true)
      .limit(1);
    const vehicle = (vehicles?.[0] as VehicleRow | undefined) ?? null;

    // ── 2. Idempotency: one contract per driver ──
    const { data: existingRaw } = await admin
      .from('driver_contracts')
      .select('id, contract_no, accepted_at, pdf_es_path, pdf_ro_path, emailed_driver_at, emailed_admin_at')
      .eq('driver_id', driver.id)
      .maybeSingle();
    const existing = existingRaw as ExistingContract | null;

    if (existing && !body.force) {
      return jsonResponse(req, {
        ok: true,
        already_existed: true,
        contract_no: existing.contract_no,
        pdf_es_path: existing.pdf_es_path,
        pdf_ro_path: existing.pdf_ro_path,
      });
    }

    // ── 3. Live T&C (Spanish annex = exactly what the driver accepted) ──
    const { data: cms } = await admin
      .from('cms_content')
      .select('title_es, body_es, updated_at')
      .eq('slug', 'terms')
      .maybeSingle();
    const termsTitleEs = (cms as { title_es?: string } | null)?.title_es ?? 'Términos y Condiciones de Servicio';
    const termsBodyEs = (cms as { body_es?: string } | null)?.body_es ?? '';
    const termsUpdatedAt = (cms as { updated_at?: string } | null)?.updated_at ?? null;

    const acceptedAt = driver.terms_accepted_at ?? existing?.accepted_at ?? new Date().toISOString();

    // ── 4. Contract number (reuse on regeneration) ──
    let contractNo: string;
    if (existing?.contract_no) {
      contractNo = existing.contract_no;
    } else {
      const { data: cn, error: cnErr } = await admin.rpc('generate_contract_no');
      if (cnErr) throw new Error(`contract_no_failed: ${cnErr.message}`);
      contractNo = cn as string;
    }

    // ── 5. Build both PDFs ──
    const fonts = await tryFetchUnicodeFonts();
    const shared = {
      contractNo,
      driver,
      user,
      driverEmail,
      vehicle,
      acceptedAtISO: acceptedAt,
      termsUpdatedAtISO: termsUpdatedAt,
      fonts,
    };
    const pdfEs = await buildContractPdf({
      ...shared,
      copy: CONTRACT_ES,
      lang: 'es',
      termsTitle: termsTitleEs,
      termsBody: termsBodyEs,
    });
    const pdfRo = await buildContractPdf({
      ...shared,
      copy: CONTRACT_RO,
      lang: 'ro',
      termsTitle: TERMS_RO_TITLE,
      termsBody: TERMS_RO_BODY,
    });

    // ── 6. Upload (upsert — re-runs replace prior PDFs) ──
    const esPath = `${driver.user_id}/${contractNo}-es.pdf`;
    const roPath = `${driver.user_id}/${contractNo}-ro.pdf`;
    for (const [path, bytes] of [[esPath, pdfEs], [roPath, pdfRo]] as const) {
      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw new Error(`storage_upload_failed (${path}): ${upErr.message}`);
    }

    // ── 7. Upsert driver_contracts ──
    const row = {
      driver_id: driver.id,
      contract_no: contractNo,
      accepted_at: acceptedAt,
      terms_updated_at: termsUpdatedAt,
      pdf_es_path: esPath,
      pdf_ro_path: roPath,
    };
    const { error: upsertErr } = await admin
      .from('driver_contracts')
      .upsert(row, { onConflict: 'driver_id' });
    if (upsertErr) throw new Error(`contract_upsert_failed: ${upsertErr.message}`);

    // ── 8. Emails (failures never fail the generation) ──
    const acceptedLabelEs = formatDateLong(acceptedAt, 'es');
    const emailData = {
      contractNo,
      driverName: user.full_name ?? '',
      driverPhone: user.phone,
      driverEmail,
      acceptedLabel: acceptedLabelEs,
      driverId: driver.id,
    };
    const esB64 = encodeBase64(pdfEs);
    const roB64 = encodeBase64(pdfRo);

    const skipDriverEmail = !driverEmail || (!!existing?.emailed_driver_at && !body.force);
    const driverEmailResult = !skipDriverEmail
      ? await sendResend({
          to: driverEmail!,
          subject: driverContractSubject('driver', contractNo),
          html: driverContractHtml({ audience: 'driver', ...emailData }),
          attachments: [{ filename: `${contractNo}-es.pdf`, content: esB64 }],
        })
      : { skipped: true as const };

    const adminEmail = Deno.env.get('ADMIN_CONTRACT_EMAIL') ?? ADMIN_EMAIL_FALLBACK;
    const skipAdminEmail = !!existing?.emailed_admin_at && !body.force;
    const adminEmailResult = !skipAdminEmail
      ? await sendResend({
          to: adminEmail,
          subject: driverContractSubject('admin', contractNo),
          html: driverContractHtml({ audience: 'admin', ...emailData }),
          attachments: [
            { filename: `${contractNo}-es.pdf`, content: esB64 },
            { filename: `${contractNo}-ro.pdf`, content: roB64 },
          ],
        })
      : { skipped: true as const };

    const stampUpdate: Record<string, string> = {};
    if ('ok' in driverEmailResult && driverEmailResult.ok) {
      stampUpdate.emailed_driver_at = new Date().toISOString();
    }
    if ('ok' in adminEmailResult && adminEmailResult.ok) {
      stampUpdate.emailed_admin_at = new Date().toISOString();
    }
    if (Object.keys(stampUpdate).length > 0) {
      await admin.from('driver_contracts').update(stampUpdate).eq('driver_id', driver.id);
    }

    return jsonResponse(req, {
      ok: true,
      contract_no: contractNo,
      accepted_at: acceptedAt,
      pdf_es_path: esPath,
      pdf_ro_path: roPath,
      unicode_font: fonts !== null,
      driver_email: driverEmailResult,
      admin_email: adminEmailResult,
    });
  } catch (err) {
    console.error('[generate-driver-contract] failed:', err);
    return jsonResponse(req, { error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

// ── Fonts ────────────────────────────────────────────────────────
// Cached per process: Supabase EFs reuse the runtime across warm
// invocations, so the ~1.1 MB of TTFs travels the wire once per cold
// start. null = negative cache (fetch failed; use Helvetica fallback).

let cachedFontBytes: { regular: Uint8Array; bold: Uint8Array } | null | undefined;

async function tryFetchUnicodeFonts(): Promise<{ regular: Uint8Array; bold: Uint8Array } | null> {
  if (cachedFontBytes !== undefined) return cachedFontBytes;
  try {
    const fetchTtf = async (url: string): Promise<Uint8Array> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`font fetch ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    };
    const [regular, bold] = await Promise.all([fetchTtf(FONT_REGULAR_URL), fetchTtf(FONT_BOLD_URL)]);
    cachedFontBytes = { regular, bold };
  } catch (err) {
    console.warn('[generate-driver-contract] Unicode font fetch failed — falling back to Helvetica + stripped diacritics:', (err as Error).message);
    cachedFontBytes = null;
  }
  return cachedFontBytes;
}

// WinAnsi fallback sanitizer: Helvetica can't encode ș/ț/ă (and other
// non-CP1252 chars). NFD-decompose + strip combining marks (covers the
// Romanian comma-below diacritics), then drop anything still outside
// Latin-1 + the typographic extras WinAnsi does support.
function sanitizeForWinAnsi(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\n -ÿ–—‘’“”•€]/g, '?');
}

// ── PDF builder ──────────────────────────────────────────────────

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_L = 50;
const MARGIN_R = 545;
const TOP_Y = 790;
const BOTTOM_Y = 64;

/** Flowing-text writer: wraps words, paginates, keeps a cursor. */
class PdfWriter {
  page: PDFPage;
  y = TOP_Y;
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly sanitize: (s: string) => string,
  ) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = TOP_Y;
  }

  ensure(height: number): void {
    if (this.y - height < BOTTOM_Y) this.newPage();
  }

  spacer(h: number): void {
    this.y -= h;
  }

  /**
   * Word-wrap a single logical line into physical lines that fit maxWidth.
   *
   * Measures each word's width ONCE and accumulates the line width by
   * addition (O(words)) instead of re-measuring the growing candidate
   * string per word (O(words²)). The quadratic version, multiplied across
   * a multi-page contract, was heavy enough to trip the Edge worker's
   * resource limit — this keeps the same layout for a fraction of the
   * width-measurement cost. widthOfTextAtSize results are memoized per
   * (token,size) for the duration of the wrap call.
   */
  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return [];
    const widthCache = new Map<string, number>();
    const measure = (t: string): number => {
      const key = `${size}:${t}`;
      let v = widthCache.get(key);
      if (v === undefined) {
        v = font.widthOfTextAtSize(t, size);
        widthCache.set(key, v);
      }
      return v;
    };
    const spaceW = measure(' ');
    const lines: string[] = [];
    let cur = '';
    let curW = 0;
    const startWord = (word: string) => {
      const wW = measure(word);
      if (wW <= maxWidth) {
        cur = word;
        curW = wW;
        return;
      }
      // Pathologically long token (e.g. a URL) — hard-break by characters.
      let chunk = '';
      let chunkW = 0;
      for (const ch of word) {
        const cw = measure(ch);
        if (chunkW + cw > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
          chunkW = cw;
        } else {
          chunk += ch;
          chunkW += cw;
        }
      }
      cur = chunk;
      curW = chunkW;
    };
    for (const word of words) {
      if (cur === '') {
        startWord(word);
        continue;
      }
      const wW = measure(word);
      if (curW + spaceW + wW <= maxWidth) {
        cur = `${cur} ${word}`;
        curW += spaceW + wW;
      } else {
        lines.push(cur);
        cur = '';
        curW = 0;
        startWord(word);
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  paragraph(
    text: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      indent?: number;
      lineGap?: number;
      spaceAfter?: number;
    } = {},
  ): void {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const color = opts.color ?? rgb(...BRAND_RGB.text);
    const indent = opts.indent ?? 0;
    const lineHeight = size + (opts.lineGap ?? 4);
    const maxWidth = MARGIN_R - MARGIN_L - indent;
    const lines = this.wrap(this.sanitize(text), font, size, maxWidth);
    for (const line of lines) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x: MARGIN_L + indent, y: this.y, size, font, color });
      this.y -= lineHeight;
    }
    this.y -= opts.spaceAfter ?? 6;
  }

  sectionHeader(title: string): void {
    this.ensure(34);
    this.page.drawText(this.sanitize(title), {
      x: MARGIN_L, y: this.y, size: 11, font: this.bold, color: rgb(...BRAND_RGB.ink),
    });
    this.page.drawLine({
      start: { x: MARGIN_L, y: this.y - 4 },
      end: { x: MARGIN_L + 36, y: this.y - 4 },
      thickness: 1.5,
      color: rgb(...BRAND_RGB.primary),
    });
    this.y -= 24;
  }

  /** Label/value row: muted label on a fixed column, wrapped value. */
  row(label: string, value: string): void {
    const size = 10;
    const valueX = MARGIN_L + 170;
    const maxWidth = MARGIN_R - valueX;
    const lines = this.wrap(this.sanitize(value), this.regular, size, maxWidth);
    const blockH = Math.max(lines.length, 1) * (size + 4);
    this.ensure(blockH);
    this.page.drawText(this.sanitize(label), {
      x: MARGIN_L, y: this.y, size, font: this.regular, color: rgb(...BRAND_RGB.muted),
    });
    for (const line of lines) {
      this.page.drawText(line, {
        x: valueX, y: this.y, size, font: this.regular, color: rgb(...BRAND_RGB.ink),
      });
      this.y -= size + 4;
    }
    if (lines.length === 0) this.y -= size + 4;
    this.y -= 2;
  }

  /** Article subheading (e.g. "Artículo 5.1 — …"): bold ink, no underline. */
  subheading(title: string): void {
    this.ensure(20);
    this.y -= 2;
    this.page.drawText(this.sanitize(title), {
      x: MARGIN_L, y: this.y, size: 10.5, font: this.bold, color: rgb(...BRAND_RGB.ink),
    });
    this.y -= 16;
  }

  /** Bullet list item with a hanging indent and an orange bullet glyph. */
  bullet(text: string, size = 10): void {
    const bulletX = MARGIN_L + 8;
    const textX = MARGIN_L + 22;
    const maxWidth = MARGIN_R - textX;
    const lineHeight = size + 4;
    const lines = this.wrap(this.sanitize(text), this.regular, size, maxWidth);
    lines.forEach((line, i) => {
      this.ensure(lineHeight);
      if (i === 0) {
        this.page.drawText('•', {
          x: bulletX, y: this.y, size, font: this.bold, color: rgb(...BRAND_RGB.primary),
        });
      }
      this.page.drawText(line, {
        x: textX, y: this.y, size, font: this.regular, color: rgb(...BRAND_RGB.text),
      });
      this.y -= lineHeight;
    });
    this.y -= 4;
  }
}

interface BuildArgs {
  copy: ContractCopy;
  lang: 'es' | 'ro';
  contractNo: string;
  driver: DriverProfileRow;
  user: UserRow;
  /** Best-effort recipient email used for the identification table. */
  driverEmail: string | null;
  /** Loaded for completeness; the licence contract has no vehicle section. */
  vehicle?: VehicleRow | null;
  acceptedAtISO: string;
  termsUpdatedAtISO: string | null;
  termsTitle: string;
  termsBody: string;
  fonts: { regular: Uint8Array; bold: Uint8Array } | null;
}

async function buildContractPdf(args: BuildArgs): Promise<Uint8Array> {
  const { copy, lang, contractNo, driver, user, driverEmail, acceptedAtISO, termsTitle, termsBody, fonts } = args;

  const doc = await PDFDocument.create();
  doc.setTitle(`${copy.docTitle} — ${contractNo}`);
  doc.setAuthor('TriciGo · MACH DIGITAL TECH S.R.L.');
  doc.setLanguage(lang);

  let regular: PDFFont;
  let bold: PDFFont;
  let sanitize: (s: string) => string;
  if (fonts) {
    doc.registerFontkit(fontkit);
    // subset:true keeps the PDF small (~80 KB) and was proven on the
    // earlier version. The Edge worker memory/CPU blow-up on this longer
    // contract came from O(words²) width measurements in wrap(), not from
    // subsetting — wrap() now measures each word once (see PdfWriter.wrap).
    regular = await doc.embedFont(fonts.regular, { subset: true });
    bold = await doc.embedFont(fonts.bold, { subset: true });
    sanitize = (s) => s;
  } else {
    regular = await doc.embedFont(StandardFonts.Helvetica);
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
    sanitize = sanitizeForWinAnsi;
  }

  const w = new PdfWriter(doc, regular, bold, sanitize);
  const primary = rgb(...BRAND_RGB.primary);
  const primaryLight = rgb(...BRAND_RGB.primaryLight);
  const muted = rgb(...BRAND_RGB.muted);
  const ink = rgb(...BRAND_RGB.ink);

  // ── Header: logo (or wordmark) + brand tagline (left) + contract chip (right) ──
  const logo = await tryEmbedLogo(doc);
  if (logo) {
    const targetH = 26;
    const lw = (logo.width / logo.height) * targetH;
    w.page.drawImage(logo, { x: MARGIN_L, y: w.y - 2, width: lw, height: targetH });
  } else {
    w.page.drawText(BRAND_NAME, { x: MARGIN_L, y: w.y, size: 22, font: bold, color: primary });
  }
  drawChip(w.page, bold, sanitize(contractNo), MARGIN_R, w.y - 4, primary, primaryLight);
  w.y -= 26;
  w.page.drawText(sanitize(copy.brandTagline), {
    x: MARGIN_L, y: w.y, size: 8.5, font: regular, color: muted,
  });
  w.y -= 22;

  // ── Title + divider ──
  w.paragraph(copy.docTitle, { size: 14, bold: true, color: ink, lineGap: 4, spaceAfter: 2 });
  w.paragraph(copy.docSubtitle, { size: 10, color: muted, spaceAfter: 8 });
  w.page.drawLine({
    start: { x: MARGIN_L, y: w.y }, end: { x: MARGIN_R, y: w.y }, thickness: 0.75, color: primary,
  });
  w.spacer(16);

  // ── Metadata strip: contract number + sign date/place ──
  const acceptedLabel = formatDateLong(acceptedAtISO, lang);
  w.row(copy.contractNoLabel, contractNo);
  w.row(copy.signDateLabel, `${acceptedLabel} · ${copy.signPlace}`);
  w.spacer(10);

  // ── Section I — parties (company data fixed in the prose) ──
  w.sectionHeader(copy.partiesTitle);
  for (const block of copy.partiesBlocks) {
    w.paragraph(block.text, { size: 10, lineGap: 5, spaceAfter: 8 });
  }
  w.spacer(4);

  // ── Section II — driver identification (filled with real data) ──
  const nv = copy.notProvided;
  const addressParts = [driver.address, driver.province, driver.municipality].filter(Boolean);
  w.sectionHeader(copy.identTitle);
  w.row(copy.identLabels.fullName, user.full_name || nv);
  w.row(copy.identLabels.idNumber, driver.identity_number || nv);
  // Driver licence number isn't stored as structured data (only the
  // uploaded document image) — left for manual completion.
  w.row(copy.identLabels.license, nv);
  w.row(copy.identLabels.address, addressParts.length ? addressParts.join(', ') : nv);
  w.row(copy.identLabels.phone, user.phone || nv);
  w.row(copy.identLabels.email, user.email || driverEmail || nv);
  w.spacer(12);

  // ── Sections III–XVI — flowing legal body ──
  for (const block of copy.bodyBlocks) {
    renderBlock(w, block, ink, muted);
  }
  w.spacer(6);

  // ── Driver declaration ──
  w.sectionHeader(copy.declarationTitle);
  w.paragraph(copy.declarationLead, { size: 10, lineGap: 5, spaceAfter: 6 });
  for (const item of copy.declarationItems) {
    w.bullet(item);
  }
  w.spacer(10);

  // ── Signatures: platform (cuño + pre-signed) | conductor (digital acceptance) ──
  w.sectionHeader(copy.signaturesTitle);
  await drawSignatureBlock(w, doc, copy, {
    acceptedLabel,
    contractNo,
    driverName: user.full_name || nv,
    driverId: driver.identity_number || '',
  });
  w.spacer(14);
  w.paragraph(copy.footerLine, { size: 7.5, color: muted, lineGap: 3, spaceAfter: 0 });

  // ── Anexo A — full live Terms & Conditions ──
  w.newPage();
  w.paragraph(copy.annexTitle, { size: 12, bold: true, color: ink, lineGap: 4, spaceAfter: 2 });
  w.paragraph(copy.annexLead, { size: 9, color: muted, spaceAfter: 4 });
  w.paragraph(termsTitle, { size: 9, color: muted, spaceAfter: 12 });

  // CMS T&C body is plain text with newlines (the web /terms page renders
  // \n as <br/>). Numbered ALL-CAPS lines are headings; "- " lines bullets.
  const tcGroups = termsBody.split(/\n{2,}/);
  for (const group of tcGroups) {
    const lines = group.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+\.\s+\S/.test(trimmed) && trimmed === trimmed.toLocaleUpperCase(lang)) {
        w.spacer(4);
        w.paragraph(trimmed, { size: 9.5, bold: true, color: ink, lineGap: 4, spaceAfter: 2 });
      } else if (trimmed.startsWith('- ')) {
        w.bullet(trimmed.slice(2), 9.5);
      } else {
        w.paragraph(trimmed, { size: 9.5, lineGap: 4, spaceAfter: 2 });
      }
    }
    w.spacer(4);
  }

  return doc.save();
}

/** Render one structured contract block (heading / subheading / paragraph / bullet). */
function renderBlock(
  w: PdfWriter,
  block: ContractBlock,
  ink: ReturnType<typeof rgb>,
  _muted: ReturnType<typeof rgb>,
): void {
  switch (block.type) {
    case 'h1':
      w.sectionHeader(block.text);
      break;
    case 'h2':
      w.subheading(block.text);
      break;
    case 'bullet':
      w.bullet(block.text);
      break;
    case 'p':
    default:
      w.paragraph(block.text, { size: 10, lineGap: 5, spaceAfter: 7, color: ink });
      break;
  }
}

interface SignatureData {
  acceptedLabel: string;
  contractNo: string;
  driverName: string;
  driverId: string;
}

/**
 * Two-column signature block. Left: LA PLATAFORMA, stamped with the
 * MACH DIGITAL TECH cuño and the pre-filled legal representative. Right:
 * EL CONDUCTOR, rendered as a digital-acceptance record (the contract is
 * generated when the driver accepts in-app) instead of a blank line.
 */
async function drawSignatureBlock(
  w: PdfWriter,
  doc: PDFDocument,
  copy: ContractCopy,
  data: SignatureData,
): Promise<void> {
  const BLOCK_H = 132;
  w.ensure(BLOCK_H);
  const topY = w.y;
  const colGap = 28;
  const colW = (MARGIN_R - MARGIN_L - colGap) / 2;
  const leftX = MARGIN_L;
  const rightX = MARGIN_L + colW + colGap;
  const ink = rgb(...BRAND_RGB.ink);
  const muted = rgb(...BRAND_RGB.muted);
  const text = rgb(...BRAND_RGB.text);
  const s = w.sanitize;

  // Column labels.
  w.page.drawText(s(copy.platformLabel), { x: leftX, y: topY, size: 10, font: w.bold, color: ink });
  w.page.drawText(s(copy.conductorLabel), { x: rightX, y: topY, size: 10, font: w.bold, color: ink });

  // Left column — cuño + pre-signed representative.
  const stamp = await embedStamp(doc);
  let lY = topY - 16;
  if (stamp) {
    const dim = 74;
    w.page.drawImage(stamp, { x: leftX, y: lY - dim, width: dim, height: dim });
    lY -= dim + 8;
  } else {
    lY -= 24;
  }
  w.page.drawText(s(copy.platformName), { x: leftX, y: lY, size: 9.5, font: w.bold, color: ink });
  lY -= 13;
  for (const line of w.wrap(s(copy.platformRep), w.regular, 9, colW)) {
    w.page.drawText(line, { x: leftX, y: lY, size: 9, font: w.regular, color: text });
    lY -= 12;
  }
  w.page.drawText(s(copy.platformRepRole), { x: leftX, y: lY, size: 8.5, font: w.regular, color: muted });

  // Right column — digital acceptance record.
  let rY = topY - 20;
  const acceptedLine = copy.acceptedElectronicallyTpl.replace('{date}', data.acceptedLabel);
  for (const line of w.wrap(s(acceptedLine), w.bold, 9, colW)) {
    w.page.drawText(line, { x: rightX, y: rY, size: 9, font: w.bold, color: ink });
    rY -= 12;
  }
  rY -= 4;
  w.page.drawText(s(copy.contractRefTpl.replace('{no}', data.contractNo)), {
    x: rightX, y: rY, size: 9, font: w.regular, color: text,
  });
  rY -= 16;
  for (const line of w.wrap(s(data.driverName), w.regular, 9, colW)) {
    w.page.drawText(line, { x: rightX, y: rY, size: 9, font: w.regular, color: text });
    rY -= 12;
  }
  if (data.driverId) {
    w.page.drawText(s(`${copy.identLabels.idNumber}: ${data.driverId}`), {
      x: rightX, y: rY, size: 8.5, font: w.regular, color: muted,
    });
  }

  w.y = topY - BLOCK_H;
}

function drawChip(
  page: PDFPage,
  fontBold: PDFFont,
  label: string,
  rightX: number,
  y: number,
  primary: ReturnType<typeof rgb>,
  primaryLight: ReturnType<typeof rgb>,
): void {
  const padX = 10;
  const cw = fontBold.widthOfTextAtSize(label, 10) + padX * 2;
  const ch = 22;
  const x = rightX - cw;
  page.drawRectangle({ x, y, width: cw, height: ch, color: primaryLight });
  page.drawRectangle({ x, y, width: cw, height: ch, borderColor: primary, borderWidth: 0.5 });
  page.drawText(label, { x: x + padX, y: y + 7, size: 10, font: fontBold, color: primary });
}

// Decode base64 → Uint8Array (mirror of encodeBase64; for the embedded cuño).
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// MACH DIGITAL TECH cuño — decoded once per process, embedded per doc.
// Returns null only if the embedded PNG fails to decode (never for a
// network reason — the bytes are bundled, see _shared/contract-stamp.ts).
let cachedStampBytes: Uint8Array | null | undefined;
async function embedStamp(pdf: PDFDocument): Promise<PDFImage | null> {
  if (cachedStampBytes === null) return null;
  if (cachedStampBytes === undefined) {
    try {
      cachedStampBytes = decodeBase64(CONTRACT_STAMP_PNG_BASE64);
    } catch (_err) {
      cachedStampBytes = null;
      return null;
    }
  }
  try {
    return await pdf.embedPng(cachedStampBytes);
  } catch (_err) {
    cachedStampBytes = null;
    return null;
  }
}

// Logo fetch+cache — same approach as generate-recharge-receipt.
let cachedLogoBytes: Uint8Array | null | undefined;
async function tryEmbedLogo(pdf: PDFDocument): Promise<PDFImage | null> {
  if (cachedLogoBytes === null) return null;
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

// ── Date formatting (America/Havana, per language) ──────────────

function formatDateLong(iso: string, lang: 'es' | 'ro'): string {
  try {
    const d = new Date(iso);
    const locale = lang === 'ro' ? 'ro-RO' : 'es-CU';
    const datePart = d.toLocaleDateString(locale, {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Havana',
    });
    const timePart = d.toLocaleTimeString(locale, {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Havana',
    });
    return `${datePart}, ${timePart} (Cuba)`;
  } catch {
    return iso;
  }
}

// ── Resend direct (multi-attachment) ─────────────────────────────

interface ResendArgs {
  to: string;
  subject: string;
  html: string;
  attachments: Array<{ filename: string; content: string }>;
}

async function sendResend(args: ResendArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return { ok: false, error: 'resend_not_configured' };

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: args.to,
        subject: args.subject,
        html: args.html,
        attachments: args.attachments,
      }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      console.warn('[generate-driver-contract] Resend send failed:', json);
      return {
        ok: false,
        error: typeof json === 'object' && json !== null
          ? (json as { message?: string }).message ?? 'send_failed'
          : 'send_failed',
      };
    }
    return { ok: true, id: (json as { id?: string }).id };
  } catch (err) {
    console.warn('[generate-driver-contract] Resend send threw:', err);
    return { ok: false, error: (err as Error).message };
  }
}
