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
import {
  rideReceiptHtml,
  rideReceiptSubject,
  type RideReceiptData,
} from './ride_receipt.ts';
import {
  driverUnderReviewHtml,
  driverUnderReviewSubject,
  type DriverUnderReviewData,
} from './driver_under_review.ts';
import {
  passwordResetHtml,
  passwordResetSubject,
  type PasswordResetData,
} from './password_reset.ts';
import {
  emailVerificationHtml,
  emailVerificationSubject,
  type EmailVerificationData,
} from './email_verification.ts';
import {
  newDeviceLoginHtml,
  newDeviceLoginSubject,
  type NewDeviceLoginData,
} from './new_device_login.ts';
import {
  giftReceivedHtml,
  giftReceivedSubject,
  type GiftReceivedData,
} from './gift_received.ts';
import {
  driverPayoutHtml,
  driverPayoutSubject,
  type DriverPayoutData,
} from './driver_payout.ts';
import {
  deliveryReceiptCustomerHtml,
  deliveryReceiptCustomerSubject,
  type DeliveryReceiptCustomerData,
} from './delivery_receipt_customer.ts';
import {
  firstRideCelebrationHtml,
  firstRideCelebrationSubject,
  type FirstRideCelebrationData,
} from './first_ride_celebration.ts';
import {
  paymentFailedHtml,
  paymentFailedSubject,
  type PaymentFailedData,
} from './payment_failed.ts';
import {
  driverApprovedHtml,
  driverApprovedSubject,
  type DriverApprovedData,
} from './driver_approved.ts';
import {
  driverRejectedHtml,
  driverRejectedSubject,
  type DriverRejectedData,
} from './driver_rejected.ts';
import {
  driverSuspendedHtml,
  driverSuspendedSubject,
  type DriverSuspendedData,
} from './driver_suspended.ts';

export type TemplateKey =
  | 'welcome'
  | 'win_back'
  | 'wallet_receipt'
  | 'ride_receipt'
  | 'driver_under_review'
  | 'password_reset'
  | 'email_verification'
  | 'new_device_login'
  | 'gift_received'
  | 'driver_payout'
  | 'delivery_receipt_customer'
  | 'first_ride_celebration'
  | 'payment_failed'
  | 'driver_approved'
  | 'driver_rejected'
  | 'driver_suspended';

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
    case 'ride_receipt': {
      const d = data as RideReceiptData;
      return {
        subject: subjectOverride ?? rideReceiptSubject,
        html: rideReceiptHtml(d),
      };
    }
    case 'driver_under_review': {
      const d = data as DriverUnderReviewData;
      return {
        subject: subjectOverride ?? driverUnderReviewSubject,
        html: driverUnderReviewHtml(d),
      };
    }
    case 'password_reset': {
      const d = data as PasswordResetData;
      return {
        subject: subjectOverride ?? passwordResetSubject,
        html: passwordResetHtml(d),
      };
    }
    case 'email_verification': {
      const d = data as EmailVerificationData;
      return {
        subject: subjectOverride ?? emailVerificationSubject,
        html: emailVerificationHtml(d),
      };
    }
    case 'new_device_login': {
      const d = data as NewDeviceLoginData;
      return {
        subject: subjectOverride ?? newDeviceLoginSubject,
        html: newDeviceLoginHtml(d),
      };
    }
    case 'gift_received': {
      const d = data as GiftReceivedData;
      return {
        subject: subjectOverride ?? giftReceivedSubject,
        html: giftReceivedHtml(d),
      };
    }
    case 'driver_payout': {
      const d = data as DriverPayoutData;
      return {
        subject: subjectOverride ?? driverPayoutSubject,
        html: driverPayoutHtml(d),
      };
    }
    case 'delivery_receipt_customer': {
      const d = data as DeliveryReceiptCustomerData;
      return {
        subject: subjectOverride ?? deliveryReceiptCustomerSubject,
        html: deliveryReceiptCustomerHtml(d),
      };
    }
    case 'first_ride_celebration': {
      const d = data as FirstRideCelebrationData;
      return {
        subject: subjectOverride ?? firstRideCelebrationSubject,
        html: firstRideCelebrationHtml(d),
      };
    }
    case 'payment_failed': {
      const d = data as PaymentFailedData;
      return {
        subject: subjectOverride ?? paymentFailedSubject,
        html: paymentFailedHtml(d),
      };
    }
    case 'driver_approved': {
      const d = data as DriverApprovedData;
      return {
        subject: subjectOverride ?? driverApprovedSubject,
        html: driverApprovedHtml(d),
      };
    }
    case 'driver_rejected': {
      const d = data as DriverRejectedData;
      return {
        subject: subjectOverride ?? driverRejectedSubject,
        html: driverRejectedHtml(d),
      };
    }
    case 'driver_suspended': {
      const d = data as DriverSuspendedData;
      return {
        subject: subjectOverride ?? driverSuspendedSubject,
        html: driverSuspendedHtml(d),
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
  return (
    key === 'welcome' ||
    key === 'win_back' ||
    key === 'wallet_receipt' ||
    key === 'ride_receipt' ||
    key === 'driver_under_review' ||
    key === 'password_reset' ||
    key === 'email_verification' ||
    key === 'new_device_login' ||
    key === 'gift_received' ||
    key === 'driver_payout' ||
    key === 'delivery_receipt_customer' ||
    key === 'first_ride_celebration' ||
    key === 'payment_failed' ||
    key === 'driver_approved' ||
    key === 'driver_rejected' ||
    key === 'driver_suspended'
  );
}

// Re-exports for callers that need the renderers/subjects directly
// without going through the registry (e.g. generate-recharge-receipt
// renders wallet_receipt inline because it also needs to attach the
// PDF and goes to Resend bypassing send-email; behavioral-emails
// passes its own subject string for backwards compat with the
// tracking in email_sends).
export { welcomeHtml, welcomeSubject };
export { winBackHtml, winBackSubject };
export { walletReceiptHtml, walletReceiptSubject };
export { rideReceiptHtml, rideReceiptSubject };
export { driverUnderReviewHtml, driverUnderReviewSubject };
export type {
  WelcomeData,
  WinBackData,
  WalletReceiptData,
  RideReceiptData,
  DriverUnderReviewData,
};
