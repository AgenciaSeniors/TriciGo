import { describe, expect, it } from 'vitest';
import {
  changeLabel,
  digestDayLabel,
  formatCount,
  teamDailyDigestHtml,
  teamDailyDigestSubject,
  type TeamDigestMetrics,
  type DigestTotals,
} from './team_daily_digest.ts';

const totals = (requested: number, completed: number, charged: number): DigestTotals => ({
  rides: { requested, completed, canceled_by_rider: 1, canceled_by_driver: 1, no_driver: 2,
    no_driver_with_offer: 1, no_driver_without_offer: 1, hours_without_coverage: 21 },
  signups: { new_riders: 2, drivers_registered: 1, drivers_approved: 1, drivers_online: 2, drivers_with_ride: 1 },
  money: { charged, commission: 525, recharged: 5000 },
  marketing: { signups_with_code: 2, referrals: 1, first_rides: 1, campaigns_sent: 1, promotion_uses: 3 },
});

const METRICS: TeamDigestMetrics = {
  day: '2026-10-07',
  current: totals(7, 2, 3500),
  previous: totals(2, 2, 800),
  week_ago: totals(1, 1, 1200),
  breakdowns: {
    municipalities: [
      { name: 'Plaza', requested: 3, completed: 1, no_driver: 0 },
      { name: '<i>Centro</i>', requested: 2, completed: 1, no_driver: 1 },
      { name: null, requested: 2, completed: 0, no_driver: 1 },
    ],
    vehicles: [{ slug: 'auto_standard', name: 'Auto', requested: 2, completed: 1, no_driver: 0 }],
    bands: [
      { band: 'dawn', requested: 2, no_driver: 1 },
      { band: 'morning', requested: 1, no_driver: 0 },
      { band: 'afternoon', requested: 1, no_driver: 0 },
      { band: 'night', requested: 3, no_driver: 1 },
    ],
  },
  pending: { drivers_under_review: 1, incidents_open: 2, sos_open: 1, disputes_open: 2, disputes_overdue: 1 },
  lists: {
    signup_codes: [{ code: 'BACO1', label: 'Baco Instagram', signups: 1 }],
    campaigns: [{ name: 'Promo <b>x</b>', status: 'sent', push_sent: 10, email_sent: 4 }],
    promotions: [{ code: 'BIENVENIDA', uses: 2 }],
  },
};

const base = {
  name: 'Ana',
  metrics: METRICS,
  panel_url: 'https://admin.tricigo.com',
  unsubscribe_url: 'https://tricigo.com/resumen-diario/baja#u=a1&t=ff',
};

// wrapHtml turns every non-ASCII character into a numeric entity; decode them to read the text.
const decode = (html: string) => html.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
const preheader = (html: string) => decode(html.match(/<div style="display: none;[^>]*>([^<]*)<\/div>/)?.[1] ?? '');

describe('team daily digest template', () => {
  it('admins see the money and the pending work', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'admin' });
    expect(html).toContain('Cobrado en viajes');
    expect(html).toContain('3,500 CUP');
    expect(html).toContain('525 CUP');
    expect(html).toContain('Pendiente ahora');
  });

  it('super admins see the money too', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'super_admin' })).toContain('Cobrado en viajes');
  });

  it('marketing sees every ride number and breakdown but no money and no pending work', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'marketing' });
    expect(html).toContain('Pedidos');
    expect(html).toContain('Sin conductor');
    expect(html).toContain('Horas sin conductores en l');
    expect(html).toContain('Municipio de recogida');
    expect(html).toContain('Tipo de veh');
    expect(html).toContain('Franja horaria');
    expect(html).not.toContain('Cobrado en viajes');
    expect(html).not.toContain('CUP');
    expect(html).not.toContain('Pendiente ahora');
  });

  it('an unknown role gets the marketing version', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'customer' });
    expect(html).not.toContain('CUP');
    expect(html).not.toContain('Pendiente ahora');
  });

  it('escapes text people write (campaign names, municipality names, codes)', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'admin' });
    expect(html).toContain('Promo &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('Promo <b>x</b>');
    expect(html).toContain('&lt;i&gt;Centro&lt;/i&gt;');
  });

  it('a ride with no known municipality shows as "Sin ubicacion"', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'marketing' })).toContain('Sin ubicaci');
  });

  it('carries the unsubscribe link, escaped', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'marketing' }))
      .toContain('href="https://tricigo.com/resumen-diario/baja#u=a1&amp;t=ff"');
  });

  it('greets by name, or without one', () => {
    expect(teamDailyDigestHtml({ ...base, role: 'admin' })).toContain('Hola, Ana:');
    expect(teamDailyDigestHtml({ ...base, name: '', role: 'admin' })).toContain('Hola:');
  });

  it('says so when there were no ride requests', () => {
    const empty = { ...METRICS, current: totals(0, 0, 0) };
    expect(teamDailyDigestHtml({ ...base, metrics: empty, role: 'marketing' })).toContain('No hubo pedidos.');
  });

  it('subject and day label in Spanish', () => {
    expect(teamDailyDigestSubject('2026-10-10')).toBe('TriciGo · resumen del sábado 10 de octubre');
    expect(digestDayLabel('2026-10-07')).toBe('miércoles 7 de octubre');
  });

  it('marketing gets every ride and sign-up line, and no money or pending number anywhere', () => {
    const html = teamDailyDigestHtml({ ...base, role: 'marketing' });
    for (const label of [
      'Completados', 'Cancelados por el pasajero', 'Cancelados por el conductor',
      'Sin conductor, con alguna oferta', 'Sin conductor, sin ninguna oferta',
      'Pasajeros nuevos', 'Conductores registrados', 'Conductores aprobados', 'Conductores en l',
      'Conductores con al menos un viaje', 'Referidos', 'Primeros viajes', 'Usos de promociones',
    ]) {
      expect(html).toContain(label);
    }
    for (const leak of [
      'Dinero', 'Comisi', 'Saldo recargado', '3,500', '5,000',
      'Conductores esperando', 'Incidentes abiertos', 'Disputas abiertas', 'SOS',
    ]) {
      expect(html).not.toContain(leak);
    }
  });

  it('escapes the person name, acquisition codes and labels, promotion codes and vehicle names', () => {
    const metrics: TeamDigestMetrics = {
      ...METRICS,
      breakdowns: {
        ...METRICS.breakdowns,
        vehicles: [{ slug: 'x', name: '<u>Moto</u>', requested: 1, completed: 0, no_driver: 1 }],
      },
      lists: {
        signup_codes: [{ code: '<c>', label: '<l>', signups: 1 }],
        campaigns: [],
        promotions: [{ code: '<q>', uses: 1 }],
      },
    };
    const html = teamDailyDigestHtml({ ...base, name: '<b>Ana</b>', metrics, role: 'admin' });
    expect(html).toContain('Hola, &lt;b&gt;Ana&lt;/b&gt;:');
    expect(html).toContain('&lt;u&gt;Moto&lt;/u&gt;');
    expect(html).toContain('&lt;c&gt;');
    expect(html).toContain('&lt;l&gt;');
    expect(html).toContain('&lt;q&gt;');
    for (const raw of ['<b>Ana', '<u>Moto', '<c>', '<l>', '<q>']) expect(html).not.toContain(raw);
  });

  it('preheader: plural for many rides', () => {
    expect(preheader(teamDailyDigestHtml({ ...base, role: 'admin' })))
      .toBe('7 viajes pedidos, 2 completados el miércoles 7 de octubre.');
  });

  it('preheader: singular for one ride, plural for zero', () => {
    const one = { ...METRICS, current: totals(1, 1, 0) };
    expect(preheader(teamDailyDigestHtml({ ...base, metrics: one, role: 'admin' })))
      .toBe('1 viaje pedido, 1 completado el miércoles 7 de octubre.');
    const mixed = { ...METRICS, current: totals(1, 0, 0) };
    expect(preheader(teamDailyDigestHtml({ ...base, metrics: mixed, role: 'marketing' })))
      .toBe('1 viaje pedido, 0 completados el miércoles 7 de octubre.');
    const none = { ...METRICS, current: totals(0, 0, 0) };
    expect(preheader(teamDailyDigestHtml({ ...base, metrics: none, role: 'marketing' })))
      .toBe('0 viajes pedidos, 0 completados el miércoles 7 de octubre.');
  });

  it('labels the four time bands in Spanish', () => {
    const text = decode(teamDailyDigestHtml({ ...base, role: 'marketing' }));
    for (const label of ['Madrugada (0 a 6 h)', 'Mañana (6 a 12 h)', 'Tarde (12 a 18 h)', 'Noche (18 a 24 h)']) {
      expect(text).toContain(label);
    }
    expect(text).not.toMatch(/>(dawn|morning|afternoon|night)</);
  });

  it('completion rate: a base day without requests shows a dash, not a division by zero', () => {
    const metrics = { ...METRICS, previous: totals(0, 0, 0), week_ago: totals(4, 1, 0) };
    const text = decode(teamDailyDigestHtml({ ...base, metrics, role: 'marketing' }));
    expect(text).toContain('Se completó el 29 % de los pedidos (día anterior: —; hace 7 días: 25 %).');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });

  it('formats counts and changes', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
    expect(changeLabel(7, 5)).toBe('▲ 40 %');
    expect(changeLabel(2, 4)).toBe('▼ 50 %');
    expect(changeLabel(5, 5)).toBe('= 0 %');
    expect(changeLabel(3, 0)).toBe('—');
    expect(changeLabel(0, 0)).toBe('—');
  });
});
