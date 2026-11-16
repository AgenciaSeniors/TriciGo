import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { activeDriverAssistMessage, riderAssistMessage, shortAddress, type AssistWhatsAppMessage } from '../assistWhatsApp';
import { waMeLink } from '../driverOutreach';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '../../../i18n/src/locales');

function adminText(locale: string, key: string): string {
  const json = JSON.parse(readFileSync(join(LOCALES, locale, 'admin.json'), 'utf8')) as Record<string, unknown>;
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], json);
  if (typeof value !== 'string') throw new Error(`admin.json (${locale}) has no ${key}`);
  return value;
}

/** What t() does with escapeValue: false. */
function render(locale: string, msg: AssistWhatsAppMessage): string {
  return adminText(locale, msg.key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => msg.vars[name] ?? `{{${name}}}`);
}

describe('shortAddress', () => {
  it('keeps the part before the first comma', () => {
    expect(shortAddress('Avenida 37 e/ 46 y 48, Playa, La Habana')).toBe('Avenida 37 e/ 46 y 48');
    expect(shortAddress('Centro de Neurociencias de Cuba, Cerca de 190 e/ A y B, Playa')).toBe(
      'Centro de Neurociencias de Cuba',
    );
  });

  it('keeps an address without a comma whole', () => {
    expect(shortAddress('Vía Blanca e/ Atarés y Acierto')).toBe('Vía Blanca e/ Atarés y Acierto');
  });

  it('trims and collapses the spaces', () => {
    expect(shortAddress('   3ra   e/ 26 y 28  , Miramar ')).toBe('3ra e/ 26 y 28');
    expect(shortAddress('3ra\ne/\t26 y 28, Miramar')).toBe('3ra e/ 26 y 28');
  });

  it('skips empty segments before the first real one', () => {
    expect(shortAddress(' , Playa, La Habana')).toBe('Playa');
  });

  it('drops a leading "Cerca de", which reads badly after "hacia"', () => {
    expect(shortAddress('Cerca de 246 e/ Avenida 221 y Avenida 223, Boyeros')).toBe('246 e/ Avenida 221 y Avenida 223');
    expect(shortAddress('cerca de Paseo e/ 37 y 39, Plaza')).toBe('Paseo e/ 37 y 39');
  });

  it('returns null for an empty address', () => {
    expect(shortAddress(null)).toBeNull();
    expect(shortAddress(undefined)).toBeNull();
    expect(shortAddress('')).toBeNull();
    expect(shortAddress('   ')).toBeNull();
    expect(shortAddress(' , , ')).toBeNull();
    expect(shortAddress('Cerca de ')).toBeNull();
  });

  it('returns null for coordinates and UI placeholders, which name no place', () => {
    expect(shortAddress('23.13570, -82.36660')).toBeNull();
    expect(shortAddress('Ubicación seleccionada en el mapa')).toBeNull();
    expect(shortAddress('Detectando dirección...')).toBeNull();
  });
});

describe('riderAssistMessage', () => {
  it('names the destination', () => {
    expect(riderAssistMessage('3ra e/ 26 y 28, Miramar, Playa')).toEqual({
      key: 'ride_assist.rider_whatsapp_text',
      vars: { destination: '3ra e/ 26 y 28' },
    });
  });

  it('falls back to a text without destination, never to the ride code', () => {
    for (const address of [null, '', '23.13570, -82.36660']) {
      expect(riderAssistMessage(address)).toEqual({ key: 'ride_assist.rider_whatsapp_text_no_destination', vars: {} });
    }
  });
});

describe('activeDriverAssistMessage', () => {
  const pickup = 'Calle 23 e/ L y M, Vedado, Plaza';
  const dropoff = 'Avenida 37 e/ 46 y 48, Playa, La Habana';

  it('names the pickup while the driver is still going for the rider', () => {
    for (const status of ['accepted', 'driver_en_route', 'arrived_at_pickup']) {
      expect(activeDriverAssistMessage(status, pickup, dropoff)).toEqual({
        key: 'ride_assist.active_driver_whatsapp_text_pickup',
        vars: { pickup: 'Calle 23 e/ L y M' },
      });
    }
  });

  it('names the destination once the rider is on board', () => {
    for (const status of ['in_progress', 'arrived_at_destination']) {
      expect(activeDriverAssistMessage(status, pickup, dropoff)).toEqual({
        key: 'ride_assist.active_driver_whatsapp_text_destination',
        vars: { destination: 'Avenida 37 e/ 46 y 48' },
      });
    }
  });

  it('uses the other address when the preferred one is empty', () => {
    expect(activeDriverAssistMessage('accepted', '', dropoff)).toEqual({
      key: 'ride_assist.active_driver_whatsapp_text_destination',
      vars: { destination: 'Avenida 37 e/ 46 y 48' },
    });
    expect(activeDriverAssistMessage('in_progress', pickup, null)).toEqual({
      key: 'ride_assist.active_driver_whatsapp_text_pickup',
      vars: { pickup: 'Calle 23 e/ L y M' },
    });
  });

  it('falls back to a text without address when both are empty', () => {
    expect(activeDriverAssistMessage('in_progress', null, '  ')).toEqual({
      key: 'ride_assist.active_driver_whatsapp_text_no_address',
      vars: {},
    });
  });
});

describe('admin.json texts', () => {
  const pickup = 'Calle 23 e/ L y M, Vedado, Plaza';
  const dropoff = '3ra e/ 26 y 28, Miramar, Playa';
  const messages: AssistWhatsAppMessage[] = [
    riderAssistMessage(dropoff),
    riderAssistMessage(null),
    activeDriverAssistMessage('accepted', pickup, dropoff),
    activeDriverAssistMessage('in_progress', pickup, dropoff),
    activeDriverAssistMessage('in_progress', null, null),
  ];

  it('every key exists in es, en and pt with exactly the variables the helper fills', () => {
    for (const locale of ['es', 'en', 'pt']) {
      for (const msg of messages) {
        const placeholders = [...adminText(locale, msg.key).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
        expect(placeholders, `${locale} ${msg.key}`).toEqual(Object.keys(msg.vars).sort());
      }
    }
  });

  it('the wa.me links name the place, never a ride code', () => {
    const rider = waMeLink('+5355550001', render('es', riderAssistMessage(dropoff)));
    expect(rider).toBe(
      `https://wa.me/5355550001?text=${encodeURIComponent('Hola, te escribe el soporte de TriciGo por tu viaje hacia 3ra e/ 26 y 28.')}`,
    );
    const driver = waMeLink('55550002', render('es', activeDriverAssistMessage('driver_en_route', pickup, dropoff)));
    expect(driver).toBe(
      `https://wa.me/5355550002?text=${encodeURIComponent('Hola, te escribe el soporte de TriciGo por el viaje con recogida en Calle 23 e/ L y M.')}`,
    );
    for (const locale of ['es', 'en', 'pt']) {
      for (const msg of messages) expect(render(locale, msg)).not.toMatch(/\{\{|code/i);
    }
  });
});
