// ============================================================
// TriciGo — i18n Configuration
// Spanish primary, English secondary
// ============================================================

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Spanish translations
import esCommon from './locales/es/common.json';
import esRider from './locales/es/rider.json';
import esDriver from './locales/es/driver.json';
import esAdmin from './locales/es/admin.json';

// English translations
import enCommon from './locales/en/common.json';
import enRider from './locales/en/rider.json';
import enDriver from './locales/en/driver.json';
import enAdmin from './locales/en/admin.json';

export const defaultNS = 'common';
export const supportedLanguages = ['es', 'en'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const resources = {
  es: {
    common: esCommon,
    rider: esRider,
    driver: esDriver,
    admin: esAdmin,
  },
  en: {
    common: enCommon,
    rider: enRider,
    driver: enDriver,
    admin: enAdmin,
  },
} as const;

export function initI18n(detectedLanguage?: string) {
  const lng = supportedLanguages.includes(detectedLanguage as SupportedLanguage)
    ? detectedLanguage
    : 'es';

  i18n.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: 'es',
    defaultNS,
    ns: ['common', 'rider', 'driver', 'admin'],
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

  return i18n;
}

export { i18n };
