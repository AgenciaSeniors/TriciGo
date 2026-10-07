// ============================================================
// Which accounts may be e-mailed at users.email (shared, Deno)
// ============================================================
// users.email is written UNVERIFIED: add-email-with-verification stores it before
// its owner opens the confirmation link, and GoTrue's open signup copies any
// address in. Mailing it as-is let an account point TriciGo's mail at a
// stranger's inbox, and sent receipts (trip addresses included) to typos.
//
// The rule lives in one SQL function, public.mailable_user_emails (migration
// 00635): an address may be mailed when its owner confirmed it
// (users.email_verified_at) or a Google/Apple identity the provider verified
// carries the same address. Every Edge Function that picks a recipient from
// users.email asks it through these helpers, with the service-role client
// (the function is not executable by clients).
//
// Fails closed: if the check cannot be made (migration missing, network),
// nobody is mailed. A missed welcome or receipt is better than mail to an
// address nobody proved.
// ============================================================

import { realEmail } from './email-guard.ts';

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** The part of the supabase-js client these helpers use. */
export interface MailableEmailClient {
  rpc(fn: 'mailable_user_emails', args: { p_user_ids: string[] }): PromiseLike<RpcResult>;
}

/** Ids per call, so a campaign of thousands stays within a request body. */
export const MAILABLE_CHUNK = 500;

/**
 * Proven addresses of the given accounts, keyed by user id. Accounts without a
 * proven address (or with only the phone-OTP placeholder) are absent.
 */
export async function fetchMailableEmails(
  client: MailableEmailClient,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += MAILABLE_CHUNK) {
    const chunk = ids.slice(i, i + MAILABLE_CHUNK);
    let res: RpcResult;
    try {
      res = await client.rpc('mailable_user_emails', { p_user_ids: chunk });
    } catch (err) {
      console.error('[mailable-emails] check failed, mailing nobody in this batch:', err);
      continue;
    }
    if (res.error) {
      console.error('[mailable-emails] check failed, mailing nobody in this batch:', res.error.message);
      continue;
    }
    if (!Array.isArray(res.data)) continue;
    for (const row of res.data) {
      if (!row || typeof row !== 'object') continue;
      const { user_id, email } = row as { user_id?: unknown; email?: unknown };
      if (typeof user_id !== 'string' || typeof email !== 'string') continue;
      const address = realEmail(email);
      if (address) out.set(user_id, address);
    }
  }
  return out;
}

/** The proven address of one account, or null. */
export async function fetchMailableEmail(
  client: MailableEmailClient,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  return (await fetchMailableEmails(client, [userId])).get(userId) ?? null;
}
