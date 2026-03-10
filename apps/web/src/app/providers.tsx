'use client';

import { useEffect, useState } from 'react';
import { initI18n } from '@tricigo/i18n';

let i18nInitialized = false;

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(i18nInitialized);

  useEffect(() => {
    if (!i18nInitialized) {
      initI18n();
      i18nInitialized = true;
      setReady(true);
    }
  }, []);

  if (!ready) return null;

  return <>{children}</>;
}
