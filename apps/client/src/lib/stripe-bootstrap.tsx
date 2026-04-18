// ============================================================
// TriciGo — StripeProvider bootstrap
//
// Wraps the app in @stripe/stripe-react-native's StripeProvider so
// PaymentSheet can be opened from the wallet recharge flow.
//
// The publishable key is loaded async from `platform_config` via
// paymentService.getStripeConfig(). Until it's loaded, or if Stripe
// is not configured for this env, StripeProvider gets an empty
// string — PaymentSheet calls will fail gracefully with an error
// the UI can show.
// ============================================================

import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { paymentService } from '@tricigo/api';

// Lazy require to avoid importing native module on web / older devices
let StripeProvider: React.ComponentType<{
  publishableKey: string;
  merchantIdentifier?: string;
  children: React.ReactNode;
}> | null = null;

if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    StripeProvider = require('@stripe/stripe-react-native').StripeProvider;
  } catch {
    StripeProvider = null;
  }
}

export function StripeBootstrap({ children }: { children: React.ReactNode }) {
  const [publishableKey, setPublishableKey] = useState('');

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        const config = await paymentService.getStripeConfig();
        if (cancelled) return;
        // Ignore placeholder value until real key arrives from Stripe onboarding
        if (config.enabled && !config.publishableKey.includes('REPLACE')) {
          setPublishableKey(config.publishableKey);
        }
      } catch {
        // Silent: if config fails, wallet page will show "Próximamente"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!StripeProvider) {
    return <>{children}</>;
  }

  return (
    <StripeProvider
      publishableKey={publishableKey}
      merchantIdentifier="merchant.app.tricigo.client"
    >
      {children}
    </StripeProvider>
  );
}
