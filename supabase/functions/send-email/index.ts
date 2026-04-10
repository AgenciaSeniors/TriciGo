// supabase/functions/send-email/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

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

interface EmailRequest {
  template: string;
  data: Record<string, unknown>;
  recipient_email: string;
  subject: string;
  locale?: 'en' | 'es';
}

interface RideReceiptLabels {
  title: string;
  date: string;
  pickup: string;
  dropoff: string;
  driver: string;
  distance: string;
  duration: string;
  service: string;
  paymentMethod: string;
  baseFare: string;
  distanceCharge: string;
  timeCharge: string;
  surge: string;
  discount: string;
  total: string;
  footer: string;
  currency: string;
}

function getLabels(locale: string): RideReceiptLabels {
  if (locale === 'en') {
    return {
      title: 'Ride Receipt',
      date: 'Date',
      pickup: 'Pickup',
      dropoff: 'Dropoff',
      driver: 'Driver',
      distance: 'Distance',
      duration: 'Duration',
      service: 'Service',
      paymentMethod: 'Payment method',
      baseFare: 'Base fare',
      distanceCharge: 'Distance charge',
      timeCharge: 'Time charge',
      surge: 'Surge pricing',
      discount: 'Discount',
      total: 'Total',
      footer: 'Thank you for riding with TriciGo!',
      currency: 'CUP',
    };
  }
  return {
    title: 'Recibo de viaje',
    date: 'Fecha',
    pickup: 'Recogida',
    dropoff: 'Destino',
    driver: 'Conductor',
    distance: 'Distancia',
    duration: 'Duraci\u00f3n',
    service: 'Servicio',
    paymentMethod: 'M\u00e9todo de pago',
    baseFare: 'Tarifa base',
    distanceCharge: 'Cargo por distancia',
    timeCharge: 'Cargo por tiempo',
    surge: 'Tarifa din\u00e1mica',
    discount: 'Descuento',
    total: 'Total',
    footer: '\u00a1Gracias por viajar con TriciGo!',
    currency: 'CUP',
  };
}

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCurrency(amount: unknown, currency: string): string {
  const num = Number(amount);
  if (isNaN(num)) return `0.00 ${currency}`;
  return `${num.toFixed(2)} ${currency}`;
}

function formatDate(dateStr: unknown, locale: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(String(dateStr));
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'es-CU', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(dateStr);
  }
}

function formatDuration(minutes: unknown): string {
  const mins = Number(minutes);
  if (isNaN(mins) || mins <= 0) return '';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function formatDistance(km: unknown): string {
  const val = Number(km);
  if (isNaN(val) || val <= 0) return '';
  return `${val.toFixed(1)} km`;
}

function renderWelcomeEmail(data: Record<string, unknown>): string {
  const name = escapeHtml(data.full_name ?? data.name ?? 'usuario');
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenido a TriciGo</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background-color:#F97316;padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">TriciGo</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px;font-size:22px;color:#333333;font-weight:700;">\u00a1Bienvenido/a, ${name}!</h2>
              <p style="margin:0 0 16px;font-size:15px;color:#555555;line-height:1.6;">
                Estamos encantados de tenerte en TriciGo, la forma m\u00e1s r\u00e1pida y segura de moverte por Cuba.
              </p>
              <p style="margin:0 0 8px;font-size:15px;color:#555555;line-height:1.6;">As\u00ed de f\u00e1cil es usar la app:</p>
              <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#555555;line-height:1.8;">
                <li>Abre la app y escribe tu destino</li>
                <li>Elige el tipo de veh\u00edculo que prefieras</li>
                <li>Confirma y espera a tu conductor</li>
              </ol>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td align="center" style="padding:8px 0 16px;">
                    <a href="https://tricigo.app" style="display:inline-block;background-color:#F97316;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:8px;">
                      Solicitar tu primer viaje
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 24px;text-align:center;border-top:1px solid #e4e4e7;">
              <p style="margin:0;font-size:14px;color:#888888;">\u00a1Gracias por unirte a TriciGo!</p>
              <p style="margin:12px 0 0;font-size:12px;color:#bbbbbb;">TriciGo &copy; ${new Date().getFullYear()}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderWinBackEmail(data: Record<string, unknown>): string {
  const name = escapeHtml(data.full_name ?? data.name ?? 'usuario');
  const days = Number(data.days_since_last_ride ?? 7);
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Te extrañamos - TriciGo</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background-color:#F97316;padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">TriciGo</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px;font-size:22px;color:#333333;font-weight:700;">\u00a1Te extra\u00f1amos, ${name}!</h2>
              <p style="margin:0 0 16px;font-size:15px;color:#555555;line-height:1.6;">
                Han pasado <strong>${days} d\u00edas</strong> desde tu \u00faltimo viaje con TriciGo.
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#555555;line-height:1.6;">
                Tu conductor favorito te est\u00e1 esperando. Vuelve a viajar c\u00f3modo y seguro.
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td align="center" style="padding:8px 0 16px;">
                    <a href="https://tricigo.app" style="display:inline-block;background-color:#F97316;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:8px;">
                      Volver a viajar
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 24px;text-align:center;border-top:1px solid #e4e4e7;">
              <p style="margin:0;font-size:14px;color:#888888;">\u00a1Te esperamos en TriciGo!</p>
              <p style="margin:12px 0 0;font-size:12px;color:#bbbbbb;">TriciGo &copy; ${new Date().getFullYear()}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderRideReceipt(data: Record<string, unknown>, locale: string): string {
  const l = getLabels(locale);

  const rideDate = formatDate(data.completed_at ?? data.created_at, locale);
  const pickupAddr = escapeHtml(data.pickup_address ?? data.pickup_name ?? '');
  const dropoffAddr = escapeHtml(data.dropoff_address ?? data.dropoff_name ?? '');
  const driverName = escapeHtml(data.driver_name ?? '');
  const distanceStr = formatDistance(data.distance_km);
  const durationStr = formatDuration(data.duration_minutes);
  const serviceType = escapeHtml(data.service_type ?? '');
  const paymentMethod = escapeHtml(data.payment_method ?? '');

  const baseFare = Number(data.base_fare ?? 0);
  const distanceCharge = Number(data.distance_charge ?? 0);
  const timeCharge = Number(data.time_charge ?? 0);
  const surgeMultiplier = Number(data.surge_multiplier ?? 1);
  const discountAmount = Number(data.discount_amount ?? 0);
  const totalFare = Number(data.final_fare ?? data.estimated_fare ?? 0);

  const hasSurge = surgeMultiplier > 1;
  const hasDiscount = discountAmount > 0;

  // Build fare breakdown rows
  let fareRows = '';

  if (baseFare > 0) {
    fareRows += `
      <tr>
        <td style="padding:8px 0;color:#555555;font-size:14px;border-bottom:1px solid #f0f0f0;">${l.baseFare}</td>
        <td style="padding:8px 0;color:#333333;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f0;">${formatCurrency(baseFare, l.currency)}</td>
      </tr>`;
  }

  if (distanceCharge > 0) {
    fareRows += `
      <tr>
        <td style="padding:8px 0;color:#555555;font-size:14px;border-bottom:1px solid #f0f0f0;">${l.distanceCharge}</td>
        <td style="padding:8px 0;color:#333333;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f0;">${formatCurrency(distanceCharge, l.currency)}</td>
      </tr>`;
  }

  if (timeCharge > 0) {
    fareRows += `
      <tr>
        <td style="padding:8px 0;color:#555555;font-size:14px;border-bottom:1px solid #f0f0f0;">${l.timeCharge}</td>
        <td style="padding:8px 0;color:#333333;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f0;">${formatCurrency(timeCharge, l.currency)}</td>
      </tr>`;
  }

  if (hasSurge) {
    fareRows += `
      <tr>
        <td style="padding:8px 0;color:#555555;font-size:14px;border-bottom:1px solid #f0f0f0;">${l.surge} (${surgeMultiplier}x)</td>
        <td style="padding:8px 0;color:#F97316;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f0;">&#x2191;</td>
      </tr>`;
  }

  if (hasDiscount) {
    fareRows += `
      <tr>
        <td style="padding:8px 0;color:#555555;font-size:14px;border-bottom:1px solid #f0f0f0;">${l.discount}</td>
        <td style="padding:8px 0;color:#16a34a;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f0;">-${formatCurrency(discountAmount, l.currency)}</td>
      </tr>`;
  }

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${l.title} - TriciGo</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background-color:#F97316;padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">TriciGo</h1>
              <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.9);font-weight:400;">${l.title}</p>
            </td>
          </tr>

          <!-- Date -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size:13px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">${l.date}</td>
                </tr>
                <tr>
                  <td style="font-size:15px;color:#333333;padding-top:4px;">${rideDate}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Route -->
          <tr>
            <td style="padding:20px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <!-- Pickup -->
                <tr>
                  <td width="24" valign="top" style="padding-top:2px;">
                    <div style="width:12px;height:12px;border-radius:50%;background-color:#16a34a;margin:0 auto;"></div>
                  </td>
                  <td style="padding-left:12px;padding-bottom:4px;">
                    <div style="font-size:11px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">${l.pickup}</div>
                    <div style="font-size:14px;color:#333333;padding-top:2px;">${pickupAddr}</div>
                  </td>
                </tr>
                <!-- Connector line -->
                <tr>
                  <td width="24" style="text-align:center;">
                    <div style="width:2px;height:20px;background-color:#d4d4d8;margin:0 auto;"></div>
                  </td>
                  <td></td>
                </tr>
                <!-- Dropoff -->
                <tr>
                  <td width="24" valign="top" style="padding-top:2px;">
                    <div style="width:12px;height:12px;border-radius:50%;background-color:#ef4444;margin:0 auto;"></div>
                  </td>
                  <td style="padding-left:12px;">
                    <div style="font-size:11px;color:#888888;text-transform:uppercase;letter-spacing:0.5px;">${l.dropoff}</div>
                    <div style="font-size:14px;color:#333333;padding-top:2px;">${dropoffAddr}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Ride Info (driver, distance, duration, service, payment) -->
          <tr>
            <td style="padding:0 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
                ${driverName ? `
                <tr>
                  <td style="padding:10px 0;color:#555555;font-size:14px;">${l.driver}</td>
                  <td style="padding:10px 0;color:#333333;font-size:14px;text-align:right;">${driverName}</td>
                </tr>` : ''}
                ${serviceType ? `
                <tr>
                  <td style="padding:10px 0;color:#555555;font-size:14px;">${l.service}</td>
                  <td style="padding:10px 0;color:#333333;font-size:14px;text-align:right;">${serviceType}</td>
                </tr>` : ''}
                ${distanceStr ? `
                <tr>
                  <td style="padding:10px 0;color:#555555;font-size:14px;">${l.distance}</td>
                  <td style="padding:10px 0;color:#333333;font-size:14px;text-align:right;">${distanceStr}</td>
                </tr>` : ''}
                ${durationStr ? `
                <tr>
                  <td style="padding:10px 0;color:#555555;font-size:14px;">${l.duration}</td>
                  <td style="padding:10px 0;color:#333333;font-size:14px;text-align:right;">${durationStr}</td>
                </tr>` : ''}
                ${paymentMethod ? `
                <tr>
                  <td style="padding:10px 0;color:#555555;font-size:14px;">${l.paymentMethod}</td>
                  <td style="padding:10px 0;color:#333333;font-size:14px;text-align:right;">${paymentMethod}</td>
                </tr>` : ''}
              </table>
            </td>
          </tr>

          <!-- Fare Breakdown -->
          <tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                ${fareRows}
              </table>
            </td>
          </tr>

          <!-- Total -->
          <tr>
            <td style="padding:16px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#FFF7ED;border-radius:8px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr>
                        <td style="font-size:16px;font-weight:700;color:#333333;">${l.total}</td>
                        <td style="font-size:22px;font-weight:700;color:#F97316;text-align:right;">${formatCurrency(totalFare, l.currency)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 32px 32px;text-align:center;">
              <p style="margin:0;font-size:14px;color:#888888;">${l.footer}</p>
              <p style="margin:12px 0 0;font-size:12px;color:#bbbbbb;">TriciGo &copy; ${new Date().getFullYear()}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Rate limit: 10 requests per IP per minute
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rl = await rateLimit(`send-email:${clientIP}`, 10, 60 * 1000);
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

    // ── Auth: verify JWT or internal service-role call ──
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const apiKey = req.headers.get('apikey') ?? '';
    const isInternalCall = apiKey === serviceRoleKey;

    if (!isInternalCall) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ error: 'Missing authorization header' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const supabaseAuth = createClient(
        Deno.env.get('SUPABASE_URL')!,
        serviceRoleKey,
      );
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
        authHeader.replace('Bearer ', ''),
      );
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: 'Invalid or expired token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const { template, data, recipient_email, subject, locale } = (await req.json()) as EmailRequest;

    if (!recipient_email || !subject || !template) {
      return new Response(
        JSON.stringify({ error: 'recipient_email, subject, and template are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // BUG-085: Validate email format before sending
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipient_email)) {
      return new Response(
        JSON.stringify({ error: 'Invalid email format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      return new Response(
        JSON.stringify({ error: 'RESEND_API_KEY not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let html = '';
    if (template === 'ride_receipt') {
      html = renderRideReceipt(data, locale ?? 'es');
    } else if (template === 'welcome') {
      html = renderWelcomeEmail(data);
    } else if (template === 'win_back') {
      html = renderWinBackEmail(data);
    } else {
      // Generic template: render data as key-value pairs with TriciGo branding
      html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#F97316;padding:24px 32px;text-align:center;">
          <h1 style="margin:0;font-size:24px;color:#ffffff;">TriciGo</h1>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <h2 style="margin:0 0 16px;font-size:18px;color:#333333;">${escapeHtml(subject)}</h2>
          <pre style="font-size:13px;color:#555555;white-space:pre-wrap;word-break:break-word;">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
        </td></tr>
        <tr><td style="padding:16px 32px 24px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#bbbbbb;">TriciGo &copy; ${new Date().getFullYear()}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: 'TriciGo <noreply@tricigo.app>',
        to: recipient_email,
        subject,
        html,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[send-email] Resend error:', result);
      return new Response(
        JSON.stringify({ error: 'Failed to send email', details: result }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, id: result.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
