// ============================================================
// TriciGo — i18n for the admin panel
// The panel only uses the 'admin' namespace, in Spanish. initI18n() (config.ts)
// bundles every namespace of every language: 787 KB of JSON, of which the panel
// used 119 KB (2026-10-12). This entry loads only what the panel uses.
// ============================================================

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esAdmin from './locales/es/admin.json';

export function initAdminI18n() {
  if (i18n.isInitialized) return i18n;

  i18n.use(initReactI18next).init({
    resources: { es: { admin: esAdmin } },
    lng: 'es',
    fallbackLng: 'es',
    defaultNS: 'admin',
    ns: ['admin'],
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

  return i18n;
}
