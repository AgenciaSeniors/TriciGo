// ============================================================
// What a campaign send produced, from the results of its channels (00649).
// Pure module: no remote imports, so packages/api's vitest runs it unmodified.
// ============================================================

import { escapeHtml } from './email-templates/_layout.ts';

export interface ChannelResult {
  channel: 'push' | 'email';
  /** The channel's Edge Function answered 2xx. */
  ok: boolean;
  /** How many it delivered (push tickets ok, e-mails accepted). */
  sent: number;
  error?: string;
}

export interface CampaignOutcome {
  status: 'sent' | 'failed';
  pushSent: number;
  emailSent: number;
  /** What the list shows as "Enviados": the larger of the two. */
  sentCount: number;
  lastError: string | null;
}

const MAX_ERROR = 500;

/**
 * 'failed' when the recipients could not be read, or when every channel that was called failed.
 * A channel that failed while another worked leaves 'sent' with its error in lastError.
 * No channel called (nobody in the segment) is 'sent' with zero.
 */
export function campaignOutcome(results: ChannelResult[], recipientError?: string): CampaignOutcome {
  const pushSent = results.find((r) => r.channel === 'push' && r.ok)?.sent ?? 0;
  const emailSent = results.find((r) => r.channel === 'email' && r.ok)?.sent ?? 0;
  const errors = [
    ...(recipientError ? [recipientError] : []),
    ...results.filter((r) => !r.ok).map((r) => `${r.channel}: ${r.error ?? 'error'}`),
  ];
  const failed = recipientError !== undefined || (results.length > 0 && results.every((r) => !r.ok));
  return {
    status: failed ? 'failed' : 'sent',
    pushSent,
    emailSent,
    sentCount: Math.max(pushSent, emailSent),
    lastError: errors.length > 0 ? errors.join(' · ').slice(0, MAX_ERROR) : null,
  };
}

/** The campaign body as e-mail HTML: escaped, with its line breaks kept. */
export function campaignEmailHtml(body: string): string {
  return `<p>${escapeHtml(body).replace(/\r?\n/g, '<br/>')}</p>`;
}
