import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
import { resources } from '@tricigo/i18n/config';

// The searching screen's status line ("2 conductores evaluando · 24s") read
// "1 conductores" for a single driver: the keys had no singular form.
async function riderT(lng: 'es' | 'en' | 'pt') {
  const i18n = i18next.createInstance();
  await i18n.init({ resources, lng, fallbackLng: 'es', ns: ['rider'], defaultNS: 'rider' });
  return i18n.t.bind(i18n);
}

describe('searching status line — singular and plural driver counts', () => {
  it('es', async () => {
    const t = await riderT('es');
    expect(t('home.drivers_evaluating_countdown', { count: 1, seconds: 24 })).toBe('1 conductor evaluando · 24s');
    expect(t('home.drivers_evaluating_countdown', { count: 2, seconds: 24 })).toBe('2 conductores evaluando · 24s');
    expect(t('home.drivers_evaluating', { count: 1 })).toBe('1 conductor evaluando...');
    expect(t('home.drivers_evaluating', { count: 3 })).toBe('3 conductores evaluando...');
  });

  it('en', async () => {
    const t = await riderT('en');
    expect(t('home.drivers_evaluating_countdown', { count: 1, seconds: 24 })).toBe('1 driver reviewing · 24s');
    expect(t('home.drivers_evaluating_countdown', { count: 2, seconds: 24 })).toBe('2 drivers reviewing · 24s');
    expect(t('home.drivers_evaluating', { count: 1 })).toBe('1 driver evaluating...');
    expect(t('home.drivers_evaluating', { count: 3 })).toBe('3 drivers evaluating...');
  });

  it('pt', async () => {
    const t = await riderT('pt');
    expect(t('home.drivers_evaluating_countdown', { count: 1, seconds: 24 })).toBe('1 motorista avaliando · 24s');
    expect(t('home.drivers_evaluating_countdown', { count: 2, seconds: 24 })).toBe('2 motoristas avaliando · 24s');
    expect(t('home.drivers_evaluating', { count: 1 })).toBe('1 motorista avaliando...');
    expect(t('home.drivers_evaluating', { count: 3 })).toBe('3 motoristas avaliando...');
  });
});
