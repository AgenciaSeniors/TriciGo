import { describe, it, expect } from 'vitest';
import { generateReceiptHTML, type PassengerReceiptData, type DriverReceiptData } from '../receipt-template';

const base = {
  receiptNo: 'TR-2026-ABCDEF12',
  rideId: 'ride-1',
  date: '2026-10-08T12:00:00Z',
  stops: [] as string[],
  serviceType: 'triciclo_basico',
  distanceM: 2400,
  durationS: 600,
  paymentMethod: 'Efectivo',
  exchangeRateUsdCup: null,
};

const passenger: PassengerReceiptData = {
  ...base,
  variant: 'passenger',
  // A ride address is free text: typed by the rider or copied from a POI name
  // (OSM, Overture, Foursquare, Google), e.g. "Viazul Santa Clara -> Varadero".
  pickupAddress: 'Calle 23 <img src=x onerror="alert(1)">',
  dropoffAddress: 'Viazul Santa Clara -> Varadero',
  stops: ['Parada <b>uno</b>'],
  driverName: 'Juan <script>alert(2)</script>',
  vehiclePlate: 'P<i>123</i>',
  subtotalCup: 1000,
  surgeMultiplier: 1,
  surgeAmountCup: 0,
  discountCup: 0,
  tipCup: 0,
  totalCup: 1000,
  fareTrc: null,
};

describe('generateReceiptHTML', () => {
  it('prints the passenger receipt text without turning it into markup', () => {
    const html = generateReceiptHTML(passenger);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>uno');
    expect(html).not.toContain('<i>123');
    expect(html).toContain('Calle 23 &lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('Viazul Santa Clara -&gt; Varadero');
    expect(html).toContain('Juan &lt;script&gt;');
  });

  it('prints the driver receipt text without turning it into markup', () => {
    const driver: DriverReceiptData = {
      ...base,
      variant: 'driver',
      pickupAddress: 'Origen <svg onload=alert(1)>',
      dropoffAddress: 'Destino',
      passengerName: 'Ana <a href="https://evil.example">aquí</a>',
      paymentMethod: 'Efectivo <u>x</u>',
      grossFareCup: 1000,
      commissionRate: 0.15,
      commissionCup: 150,
      tipCup: 0,
      netCup: 850,
    };
    const html = generateReceiptHTML(driver);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<a href');
    expect(html).not.toContain('<u>');
    expect(html).toContain('Ana &lt;a href=&quot;https://evil.example&quot;&gt;');
  });

  it('keeps its own markup', () => {
    const html = generateReceiptHTML(passenger);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<table');
    expect(html).toContain('TR-2026-ABCDEF12');
  });
});
