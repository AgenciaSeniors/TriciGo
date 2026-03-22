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
import esWeb from './locales/es/web.json';

// English translations
import enCommon from './locales/en/common.json';
import enRider from './locales/en/rider.json';
import enDriver from './locales/en/driver.json';
import enAdmin from './locales/en/admin.json';
import enWeb from './locales/en/web.json';

// Portuguese translations
import ptCommon from './locales/pt/common.json';
import ptRider from './locales/pt/rider.json';
import ptDriver from './locales/pt/driver.json';
import ptWeb from './locales/pt/web.json';

export const defaultNS = 'common';
export const supportedLanguages = ['es', 'en', 'pt'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const resources = {
  es: {
    common: esCommon,
    rider: esRider,
    driver: esDriver,
    admin: esAdmin,
    web: esWeb,
  },
  en: {
    common: enCommon,
    rider: enRider,
    driver: enDriver,
    admin: enAdmin,
    web: enWeb,
  },
  pt: {
    common: ptCommon,
    rider: ptRider,
    driver: ptDriver,
    web: ptWeb,
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
    ns: ['common', 'rider', 'driver', 'admin', 'web'],
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
