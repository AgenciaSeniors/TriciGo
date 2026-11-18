import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The overlay copy lives in two namespaces: the Ajustes screen reads 'common'
// (useTranslation('common')), the alerts read 'driver' (i18next.t('driver:…')).
// A key in the wrong file falls back to the Spanish defaultValue in en and pt.
function locale(lang: string, ns: string): Record<string, Record<string, string>> {
  const path = fileURLToPath(new URL(`../../../../packages/i18n/src/locales/${lang}/${ns}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Record<string, string>>;
}

const LANGS = ['es', 'en', 'pt'] as const;

describe('overlay copy', () => {
  it.each(LANGS)('%s: the Ajustes rows are in common.json', (lang) => {
    const overlay = locale(lang, 'common').overlay ?? {};
    expect(overlay.settings_xiaomi_title).toBeTruthy();
    expect(overlay.settings_xiaomi_sub).toBeTruthy();
  });

  it.each(LANGS)('%s: the Xiaomi alert is in driver.json', (lang) => {
    const overlay = locale(lang, 'driver').overlay ?? {};
    for (const key of ['xiaomi_title', 'xiaomi_body', 'xiaomi_open', 'xiaomi_done']) {
      expect(overlay[key], key).toBeTruthy();
    }
  });

  // "Abrir permisos" may land on the app's system page instead of MIUI's
  // permission list (the MIUI screen is not always reachable): the alert has
  // to tell the driver where the switch is on that page too.
  it.each([
    ['es', 'Otros permisos'],
    ['en', 'Other permissions'],
    ['pt', 'Outras permissões'],
  ])('%s: the Xiaomi alert names the "%s" section of the app page', (lang, section) => {
    expect(locale(lang, 'driver').overlay?.xiaomi_body).toContain(section);
  });
});
