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

/** Longest last_error a campaign row keeps. */
export const MAX_ERROR = 500;

/**
 * Recipients per call to send-push or send-bulk-email. Both look the ids up with
 * `.in(...)`, which puts every id in the PostgREST URL: through the gateway 600 uuids still
 * answered 200 and 700 already 400 Bad Request. 300 stays well under that, and keeps each
 * send-bulk-email call short (it mails one address at a time, ~0.25 s each, so ~75 s per call
 * against the 150 s request limit of an Edge Function).
 */
export const RECIPIENT_CHUNK = 300;

/**
 * The channels a campaign's `channel` column sends, push first; null for any other value
 * (campaigns.channel has no CHECK, so the row can hold anything).
 */
export function campaignChannels(channel: unknown): Array<ChannelResult['channel']> | null {
  if (channel === 'push') return ['push'];
  if (channel === 'email') return ['email'];
  if (channel === 'both') return ['push', 'email'];
  return null;
}

/** The ids in order, in chunks of at most `size`. */
export function chunkIds(ids: readonly string[], size: number = RECIPIENT_CHUNK): string[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunkIds: size must be a positive integer, got ${size}`);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/**
 * One channel's result from the results of its batches: ok when at least one batch worked,
 * `sent` summed over the batches that worked. When any batch failed, the error says how many and
 * quotes the first error ("2/4 batches failed: HTTP 500"); a single batch keeps its error as is.
 */
export function mergeChannelResults(channel: ChannelResult['channel'], parts: ChannelResult[]): ChannelResult {
  const okParts = parts.filter((p) => p.ok);
  const failedParts = parts.filter((p) => !p.ok);
  const merged: ChannelResult = {
    channel,
    ok: parts.length === 0 || okParts.length > 0,
    sent: okParts.reduce((sum, p) => sum + p.sent, 0),
  };
  if (failedParts.length > 0) {
    const first = failedParts[0].error ?? 'error';
    merged.error = parts.length === 1 ? first : `${failedParts.length}/${parts.length} batches failed: ${first}`;
  }
  return merged;
}

/**
 * 'failed' when the campaign could not be sent at all (`fatalError`: the recipients could not be
 * read, or the channel is unknown), or when every channel that was called failed. A channel that
 * failed, or that worked with some of its batches failing, while the campaign still reached
 * someone leaves 'sent' with its error in lastError. No channel called (nobody in the segment) is
 * 'sent' with zero.
 */
export function campaignOutcome(results: ChannelResult[], fatalError?: string): CampaignOutcome {
  const pushSent = results.find((r) => r.channel === 'push' && r.ok)?.sent ?? 0;
  const emailSent = results.find((r) => r.channel === 'email' && r.ok)?.sent ?? 0;
  const errors = [
    ...(fatalError ? [fatalError] : []),
    ...results.filter((r) => !r.ok || r.error).map((r) => `${r.channel}: ${r.error ?? 'error'}`),
  ];
  const failed = fatalError !== undefined || (results.length > 0 && results.every((r) => !r.ok));
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
