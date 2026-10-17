import { describe, expect, it, vi } from 'vitest';
import { getI18n } from 'react-i18next';
import { i18n } from '@tricigo/i18n';
import { applyStartupLanguage, bootI18n, startupLanguage } from '../i18nStartup';

// Release 1.8.0 crashed with "Should have a queue" (Sentry TRICIGO-MOBILE-19):
// i18n was initialized in an AppProviders effect, after the first render, so a
// useTranslation in that first render found no instance and skipped its hooks,
// then called them on the next render. bootI18n must leave react-i18next with
// a ready instance before anything renders.
describe('bootI18n', () => {
  it('gives react-i18next an instance synchronously', () => {
    expect(getI18n()).toBeUndefined();

    bootI18n();

    expect(getI18n()).toBe(i18n);
    expect(i18n.t('retry', { ns: 'common' })).toBe('Reintentar');
  });

  it('does not initialize twice', () => {
    bootI18n();
    const init = vi.spyOn(i18n, 'init');

    bootI18n();

    expect(init).not.toHaveBeenCalled();
    init.mockRestore();
  });
});

describe('startupLanguage', () => {
  it('uses the language saved in settings', () => {
    expect(startupLanguage('en', 'pt')).toBe('en');
  });

  it('falls back to the device language when nothing usable is saved', () => {
    expect(startupLanguage(null, 'pt')).toBe('pt');
    expect(startupLanguage('fr', 'en')).toBe('en');
  });

  it('falls back to Spanish when neither language is supported', () => {
    expect(startupLanguage(null, 'fr')).toBe('es');
    expect(startupLanguage(undefined, undefined)).toBe('es');
  });
});

describe('applyStartupLanguage', () => {
  it('switches the booted instance to the startup language', async () => {
    bootI18n();

    await applyStartupLanguage('en', 'es');
    expect(i18n.language).toBe('en');
    expect(i18n.t('retry', { ns: 'common' })).toBe('Retry');

    await applyStartupLanguage(null, 'es');
    expect(i18n.language).toBe('es');
  });
});
