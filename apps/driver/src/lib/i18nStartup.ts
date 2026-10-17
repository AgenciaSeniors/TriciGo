import { i18n, initI18n, supportedLanguages, type SupportedLanguage } from '@tricigo/i18n';

/**
 * Initializes i18n in Spanish, synchronously. AppProviders calls it at module
 * load, before the first render.
 *
 * A useTranslation that renders before i18n exists returns without calling its
 * hooks and calls them on the next render, so React sees a different hook
 * order and crashes with "Should have a queue". That is how the passenger app
 * 1.8.0 crashed (Sentry TRICIGO-MOBILE-19). The saved language is applied
 * afterwards with applyStartupLanguage.
 */
export function bootI18n(): void {
  if (i18n.isInitialized) return;
  initI18n('es');
}

function isSupported(lang: string | null | undefined): lang is SupportedLanguage {
  return supportedLanguages.includes(lang as SupportedLanguage);
}

/** The language to start in: the one saved in settings (`tricigo_language`), else Spanish. */
export function startupLanguage(saved: string | null | undefined): SupportedLanguage {
  return isSupported(saved) ? saved : 'es';
}

/** Switches the booted instance to the startup language. */
export async function applyStartupLanguage(saved: string | null | undefined): Promise<void> {
  const lang = startupLanguage(saved);
  if (i18n.language !== lang) await i18n.changeLanguage(lang);
}
