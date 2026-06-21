// ============================================================
// Shared D7 Networks SMS sender.
//
// D7 is TriciGo's SOLE SMS provider (Cuba + rest of world).
// Twilio + Meta WhatsApp fallback were fully removed 2026-06-07
// (Twilio doesn't deliver to Cuba; D7 delivers globally — verified
// ~9s delivery to +53 with DLR confirmation).
//
// `ok` means D7 ACCEPTED the message (HTTP 200 + request_id).
// Final delivery is confirmed later by the DLR webhook
// (process-sms-dlr) which upserts sms_deliveries to
// delivered / un_delivered.
// ============================================================
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';

export interface D7SendResult {
  ok: boolean;
  status: number;
  requestId?: string;
  error?: unknown;
}

const D7_URL = 'https://api.d7networks.com/messages/v1/send';

/**
 * Send a single SMS via D7 Networks.
 *
 * Uses unicode (UCS-2) data coding so accented Spanish (ó, ñ, ¿)
 * renders correctly — GSM-7 ('text' coding without unicode) would
 * mangle "código" to "c?digo" on delivery.
 *
 * When `opts.tracker` (a service-role Supabase client) is provided,
 * inserts an sms_deliveries row (status 'sent') for DLR correlation.
 */
export async function sendSmsViaD7(
  phone: string,
  body: string,
  opts?: { tracker?: SupabaseClient; eventType?: string },
): Promise<D7SendResult> {
  const token = Deno.env.get('D7_API_TOKEN');
  if (!token) {
    console.error('[d7] D7_API_TOKEN not configured');
    return { ok: false, status: 0, error: 'd7_not_configured' };
  }
  const sender = Deno.env.get('D7_SENDER_ID') || 'TriciGo';

  let res: Response;
  try {
    res = await fetch(D7_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        messages: [{
          channel: 'sms',
          recipients: [phone],
          content: body,
          msg_type: 'text',
          data_coding: 'unicode',
        }],
        message_globals: { originator: sender },
      }),
    });
  } catch (err) {
    console.error('[d7] network error:', (err as Error).message);
    return { ok: false, status: 0, error: (err as Error).message };
  }

  const result = await res.json().catch(() => ({} as Record<string, unknown>));
  const requestId = (result as { request_id?: string }).request_id;
  console.log('[d7] send:', JSON.stringify({
    status: res.status,
    request_id: requestId,
    errors: (result as { errors?: unknown }).errors,
  }));

  // Best-effort delivery tracking — process-sms-dlr updates the status later.
  if (res.ok && requestId && opts?.tracker) {
    try {
      await opts.tracker.from('sms_deliveries').insert({
        request_id: requestId,
        recipient: phone,
        originator: sender,
        provider: 'd7',
        status: 'sent',
        sent_at: new Date().toISOString(),
        raw_dlr: { initial_send_response: result, event_type: opts?.eventType ?? null },
      });
    } catch (trackErr) {
      console.error('[d7] sms_deliveries insert failed (non-fatal):', (trackErr as Error).message);
    }
  }

  return { ok: res.ok, status: res.status, requestId, error: res.ok ? undefined : result };
}
