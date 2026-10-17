import { i18n, initI18n, supportedLanguages, type SupportedLanguage } from '@tricigo/i18n';

/**
 * Initializes i18n in Spanish, synchronously. AppProviders calls it at module
 * load, before the first render.
 *
 * It used to be initialized in an AppProviders effect, after the first render.
 * A useTranslation in that render found no instance, returned without calling
 * its hooks, and called them on the next render. React saw a different hook
 * order and crashed with "Should have a queue" (release 1.8.0, Sentry
 * TRICIGO-MOBILE-19). The saved or device language is applied afterwards with
 * applyStartupLanguage.
 */
export function bootI18n(): void {
  if (i18n.isInitialized) return;
  initI18n('es');
}

function isSupported(lang: string | null | undefined): lang is SupportedLanguage {
  return supportedLanguages.includes(lang as SupportedLanguage);
}

/**
 * The language to start in: the one saved in settings (`tricigo_language`),
 * else the device language, else Spanish.
 */
export function startupLanguage(
  saved: string | null | undefined,
  deviceLanguage: string | null | undefined,
): SupportedLanguage {
  if (isSupported(saved)) return saved;
  if (isSupported(deviceLanguage)) return deviceLanguage;
  return 'es';
}

/** Switches the booted instance to the startup language. */
export async function applyStartupLanguage(
  saved: string | null | undefined,
  deviceLanguage: string | null | undefined,
): Promise<void> {
  const lang = startupLanguage(saved, deviceLanguage);
  if (i18n.language !== lang) await i18n.changeLanguage(lang);
}
