// ============================================================
// TriciGo — Email template registry
//
// Centralized lookup so callers (send-email edge function, the
// behavioral-emails cron, etc.) can resolve a template *key*
// (e.g. "welcome") to a render function instead of trying to
// pass the HTML around as a string.
//
// Adding a new template:
//   1. Create supabase/functions/_shared/email-templates/<key>.ts
//      that exports `<key>Subject` and `<key>Html(data)`.
//   2. Add it to the TEMPLATES record below.
//   3. The send-email function will resolve it automatically when
//      invoked with `{ template: "<key>", data: {...} }`.
// ============================================================

import { welcomeHtml, welcomeSubject, type WelcomeData } from './welcome.ts';
import { winBackHtml, winBackSubject, type WinBackData } from './win_back.ts';
import {
  walletReceiptHtml,
  walletReceiptSubject,
  type WalletReceiptData,
} from './wallet_receipt.ts';

export type TemplateKey = 'welcome' | 'win_back' | 'wallet_receipt';

export interface RenderedTemplate {
  subject: string;
  html: string;
}

/**
 * Resolve a template key + data to its rendered subject and HTML.
 * Throws if the key is unknown — callers should branch on this to
 * fall back to legacy-string-template behaviour.
 */
export function renderTemplate(
  key: TemplateKey,
  data: Record<string, unknown>,
  /** Optional override for the subject line (e.g. when caller already localized it). */
  subjectOverride?: string,
): RenderedTemplate {
  switch (key) {
    case 'welcome': {
      const d = data as WelcomeData;
      return {
        subject: subjectOverride ?? welcomeSubject,
        html: welcomeHtml(d),
      };
    }
    case 'win_back': {
      const d = data as WinBackData;
      return {
        subject: subjectOverride ?? winBackSubject,
        html: winBackHtml(d),
      };
    }
    case 'wallet_receipt': {
      const d = data as WalletReceiptData;
      return {
        subject: subjectOverride ?? walletReceiptSubject(d.receiptNo, d.audience),
        html: walletReceiptHtml(d),
      };
    }
    default: {
      // Exhaustiveness check — TS will flag this if a TemplateKey
      // case is missing above.
      const _exhaustive: never = key;
      throw new Error(`Unknown template key: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Type guard — true if `key` matches a registered template.
 * Use in send-email to decide between rendering via registry or
 * falling back to the legacy "template-as-string-html" behaviour
 * that some older callers (admin bulk sender, ad-hoc DB triggers)
 * still rely on.
 */
export function isTemplateKey(key: string): key is TemplateKey {
  return key === 'welcome' || key === 'win_back' || key === 'wallet_receipt';
}

// Re-exports for callers that need the subject line independently
// (e.g. behavioral-emails passes its own subject for backwards
// compat with the existing tracking in email_sends).
export { welcomeSubject, winBackSubject, walletReceiptSubject };
export type { WelcomeData, WinBackData, WalletReceiptData };
