// ============================================================
// TriciGo — Team daily digest e-mail (00656)
//
// The 7:00 Havana e-mail to every panel account with the previous day's numbers
// (docs/superpowers/specs/2026-10-11-team-daily-digest-design.md). metrics is what
// team_daily_metrics(day) returns. Marketing never gets the Money and Pending blocks; any role
// other than super_admin and admin gets the marketing version.
//
// Not in the template registry on purpose: send-team-digest renders it and hands send-email the
// HTML (its raw-HTML path, which the database alerts also use), so adding this e-mail needed no
// redeploy of send-email.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface DigestRides {
  requested: number;
  completed: number;
  canceled_by_rider: number;
  canceled_by_driver: number;
  no_driver: number;
  no_driver_with_offer: number;
  no_driver_without_offer: number;
  hours_without_coverage: number;
}
export interface DigestSignups {
  new_riders: number;
  drivers_registered: number;
  drivers_approved: number;
  drivers_online: number;
  drivers_with_ride: number;
}
export interface DigestMoney {
  charged: number;
  commission: number;
  recharged: number;
}
export interface DigestMarketing {
  signups_with_code: number;
  referrals: number;
  first_rides: number;
  campaigns_sent: number;
  promotion_uses: number;
}
export interface DigestTotals {
  rides: DigestRides;
  signups: DigestSignups;
  money: DigestMoney;
  marketing: DigestMarketing;
}
export interface DigestBreakdowns {
  municipalities: Array<{ name: string | null; requested: number; completed: number; no_driver: number }>;
  vehicles: Array<{ slug: string; name: string; requested: number; completed: number; no_driver: number }>;
  bands: Array<{ band: string; requested: number; no_driver: number }>;
}
export interface DigestPending {
  drivers_under_review: number;
  incidents_open: number;
  sos_open: number;
  disputes_open: number;
  disputes_overdue: number;
}
export interface DigestLists {
  signup_codes: Array<{ code: string; label: string | null; signups: number }>;
  campaigns: Array<{ name: string; status: string; push_sent: number; email_sent: number }>;
  promotions: Array<{ code: string; uses: number }>;
}
export interface TeamDigestMetrics {
  day: string;
  current: DigestTotals;
  previous: DigestTotals;
  week_ago: DigestTotals;
  breakdowns: DigestBreakdowns;
  pending: DigestPending;
  lists: DigestLists;
}
export interface TeamDailyDigestData {
  role: string;
  name: string;
  metrics: TeamDigestMetrics;
  panel_url: string;
  unsubscribe_url: string;
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
  'octubre', 'noviembre', 'diciembre'];
const BAND_LABELS: Record<string, string> = {
  dawn: 'Madrugada (0 a 6 h)',
  morning: 'Mañana (6 a 12 h)',
  afternoon: 'Tarde (12 a 18 h)',
  night: 'Noche (18 a 24 h)',
};
const CAMPAIGN_STATUS: Record<string, string> = { sent: 'Enviada', failed: 'Falló' };

/** '2026-10-07' -> 'miércoles 7 de octubre'. The day is a calendar date: no time zone involved. */
export function digestDayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} de ${MONTHS[m - 1]}`;
}

export function teamDailyDigestSubject(day: string): string {
  return `TriciGo · resumen del ${digestDayLabel(day)}`;
}

/** Whole number with thousands separated by commas (as formatCUP shows them). */
export function formatCount(n: number): string {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCup(n: number): string {
  return `${formatCount(n)} CUP`;
}

export function percentOf(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : '—';
}

/** Change against a base day: '▲ 40 %', '▼ 50 %', '= 0 %', or '—' when the base is 0. */
export function changeLabel(current: number, base: number): string {
  if (!base) return '—';
  const diff = Math.round(((current - base) / base) * 100);
  if (diff === 0) return '= 0 %';
  return `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} %`;
}

export function seesMoney(role: string): boolean {
  return role === 'super_admin' || role === 'admin';
}

const TH = `padding: 6px 8px; font-family: ${FONT_STACK}; font-size: 12px; font-weight: 600; color: ${COLORS.muted}; border-bottom: 1px solid ${COLORS.border};`;
const TD = `padding: 6px 8px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; border-bottom: 1px solid ${COLORS.border};`;
const SPACER = '<div style="height: 12px; line-height: 12px;">&nbsp;</div>';

function heading(title: string): string {
  return `<h2 style="margin: 28px 0 8px; font-family: ${FONT_STACK}; font-size: 17px; color: ${COLORS.ink};">${escapeHtml(title)}</h2>`;
}

function note(text: string): string {
  return `<p style="margin: 8px 0 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted};">${escapeHtml(text)}</p>`;
}

/** Every cell is escaped. Columns from numericFrom on are right-aligned. */
function table(headers: string[], rows: string[][], numericFrom = 1): string {
  const align = (i: number) => (i >= numericFrom ? ' text-align: right; white-space: nowrap;' : ' text-align: left;');
  const head = headers.map((h, i) => `<th style="${TH}${align(i)}">${escapeHtml(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td style="${TD}${align(i)}">${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse: collapse;"><tr>${head}</tr>${body}</table>`;
}

/** Reads one total out of a day's totals. */
type TotalOf = (t: DigestTotals) => number;

function totalsTable(m: TeamDigestMetrics, rows: Array<[string, TotalOf, ((n: number) => string)?]>): string {
  return table(
    ['', 'Día', 'vs. día anterior', 'vs. hace 7 días'],
    rows.map(([label, pick, fmt = formatCount]) => [
      label,
      fmt(pick(m.current)),
      changeLabel(pick(m.current), pick(m.previous)),
      changeLabel(pick(m.current), pick(m.week_ago)),
    ]),
  );
}

export function teamDailyDigestHtml(d: TeamDailyDigestData): string {
  const m = d.metrics;
  const c = m.current;
  const day = digestDayLabel(m.day);
  const parts: string[] = [];

  parts.push(`<p style="margin: 0 0 12px;">${d.name ? `Hola, ${escapeHtml(d.name)}:` : 'Hola:'}</p>`);
  parts.push(
    `<p style="margin: 0 0 4px;">Estos son los números del ${escapeHtml(day)}, en hora de Cuba. ` +
      'Cada total se compara con el día anterior y con el mismo día de la semana pasada.</p>',
  );

  parts.push(heading('Viajes'));
  parts.push(totalsTable(m, [
    ['Pedidos', (t) => t.rides.requested],
    ['Completados', (t) => t.rides.completed],
    ['Cancelados por el pasajero', (t) => t.rides.canceled_by_rider],
    ['Cancelados por el conductor', (t) => t.rides.canceled_by_driver],
    ['Sin conductor', (t) => t.rides.no_driver],
    ['Sin conductor, con alguna oferta', (t) => t.rides.no_driver_with_offer],
    ['Sin conductor, sin ninguna oferta', (t) => t.rides.no_driver_without_offer],
    ['Horas sin conductores en línea', (t) => t.rides.hours_without_coverage],
  ]));
  if (c.rides.requested === 0) {
    parts.push(note('No hubo pedidos.'));
  } else {
    parts.push(note(
      `Se completó el ${percentOf(c.rides.completed, c.rides.requested)} de los pedidos ` +
        `(día anterior: ${percentOf(m.previous.rides.completed, m.previous.rides.requested)}; ` +
        `hace 7 días: ${percentOf(m.week_ago.rides.completed, m.week_ago.rides.requested)}).`,
    ));
  }

  parts.push(heading('Altas y conductores'));
  parts.push(totalsTable(m, [
    ['Pasajeros nuevos', (t) => t.signups.new_riders],
    ['Conductores registrados', (t) => t.signups.drivers_registered],
    ['Conductores aprobados', (t) => t.signups.drivers_approved],
    ['Conductores en línea', (t) => t.signups.drivers_online],
    ['Conductores con al menos un viaje', (t) => t.signups.drivers_with_ride],
  ]));

  parts.push(heading('Dónde y cuándo se pidió'));
  if (c.rides.requested === 0) {
    parts.push(note('No hubo pedidos.'));
  } else {
    parts.push(table(
      ['Municipio de recogida', 'Pedidos', 'Completados', 'Sin conductor'],
      m.breakdowns.municipalities.map((r) => [
        r.name ?? 'Sin ubicación', formatCount(r.requested), formatCount(r.completed), formatCount(r.no_driver),
      ]),
    ));
    parts.push(SPACER);
    parts.push(table(
      ['Tipo de vehículo', 'Pedidos', 'Completados', 'Sin conductor'],
      m.breakdowns.vehicles.map((r) => [r.name, formatCount(r.requested), formatCount(r.completed), formatCount(r.no_driver)]),
    ));
    parts.push(SPACER);
    parts.push(table(
      ['Franja horaria', 'Pedidos', 'Sin conductor'],
      m.breakdowns.bands.map((b) => [BAND_LABELS[b.band] ?? b.band, formatCount(b.requested), formatCount(b.no_driver)]),
    ));
  }

  parts.push(heading('Marketing'));
  parts.push(totalsTable(m, [
    ['Altas con código', (t) => t.marketing.signups_with_code],
    ['Referidos', (t) => t.marketing.referrals],
    ['Primeros viajes', (t) => t.marketing.first_rides],
    ['Campañas enviadas', (t) => t.marketing.campaigns_sent],
    ['Usos de promociones', (t) => t.marketing.promotion_uses],
  ]));
  if (m.lists.signup_codes.length > 0) {
    parts.push(SPACER);
    parts.push(table(
      ['Código', 'Nombre', 'Altas'],
      m.lists.signup_codes.map((s) => [s.code, s.label ?? '—', formatCount(s.signups)]),
      2,
    ));
  }
  if (m.lists.campaigns.length > 0) {
    parts.push(SPACER);
    parts.push(table(
      ['Campaña', 'Estado', 'Push', 'Correo'],
      m.lists.campaigns.map((x) => [x.name, CAMPAIGN_STATUS[x.status] ?? x.status, formatCount(x.push_sent), formatCount(x.email_sent)]),
      2,
    ));
  }
  if (m.lists.promotions.length > 0) {
    parts.push(SPACER);
    parts.push(table(['Promoción', 'Usos'], m.lists.promotions.map((p) => [p.code, formatCount(p.uses)])));
  }

  if (seesMoney(d.role)) {
    parts.push(heading('Dinero'));
    parts.push(totalsTable(m, [
      ['Cobrado en viajes', (t) => t.money.charged, formatCup],
      ['Comisión de la plataforma', (t) => t.money.commission, formatCup],
      ['Saldo recargado', (t) => t.money.recharged, formatCup],
    ]));

    const p = m.pending;
    parts.push(heading('Pendiente ahora'));
    parts.push(table(['', 'Cantidad'], [
      ['Conductores esperando aprobación', formatCount(p.drivers_under_review)],
      ['Incidentes abiertos', `${formatCount(p.incidents_open)} (SOS: ${formatCount(p.sos_open)})`],
      ['Disputas abiertas', `${formatCount(p.disputes_open)} (fuera de plazo: ${formatCount(p.disputes_overdue)})`],
    ]));
  }

  parts.push(
    `<p style="margin: 28px 0 0; font-family: ${FONT_STACK}; font-size: 12px; color: ${COLORS.muted};">` +
      'Recibes este resumen porque tienes un rol en el panel de TriciGo. ' +
      `<a href="${escapeHtml(d.unsubscribe_url)}" style="color: ${COLORS.muted};">Dejar de recibir este resumen</a></p>`,
  );

  return wrapHtml({
    preheader: `${formatCount(c.rides.requested)} pedidos y ${formatCount(c.rides.completed)} completados el ${day}.`,
    hero: { title: 'Resumen del día', subtitle: day.charAt(0).toUpperCase() + day.slice(1) },
    body: parts.join('\n'),
    cta: { label: 'Abrir el panel', href: d.panel_url },
    footerNote: 'Sale todos los días a las 7:00, hora de Cuba.',
  });
}
