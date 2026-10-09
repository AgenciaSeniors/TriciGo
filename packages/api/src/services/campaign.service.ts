// ============================================================
// Campaigns (00649). The panel only creates the row; the Edge Function send-campaign sends it,
// right away (sendNow) or when the cron job finds it due.
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

export type CampaignChannel = 'push' | 'email' | 'both';
export type CampaignAudience = 'customer' | 'driver';
export type CampaignSegment = 'new_users' | 'power_users' | 'inactive' | 'all' | 'by_city';

export interface NewCampaign {
  name: string;
  audienceRole: CampaignAudience;
  segmentType: CampaignSegment;
  segmentCityId: string | null;
  title: string;
  body: string;
  promoCodeId: string | null;
  channel: CampaignChannel;
  /** UTC ISO instant; null sends as soon as possible. */
  scheduledAt: string | null;
}

export interface CampaignChannelResult {
  channel: 'push' | 'email';
  ok: boolean;
  sent: number;
  error?: string;
}

export interface CampaignSendResult {
  id: string;
  status: 'sent' | 'failed';
  recipient_count: number;
  push_sent: number;
  email_sent: number;
  sent_count: number;
  last_error: string | null;
  channels: CampaignChannelResult[];
}

export const campaignService = {
  /** Inserts the campaign. Status, counters and created_by are set by the server. */
  async create(input: NewCampaign): Promise<string> {
    const supabase = getSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('campaigns')
      .insert({
        name: input.name,
        audience_role: input.audienceRole,
        segment_type: input.segmentType,
        segment_city_id: input.segmentCityId,
        message_title: input.title,
        message_body: input.body,
        promo_code_id: input.promoCodeId,
        channel: input.channel,
        scheduled_at: input.scheduledAt,
        created_by: user?.id ?? null,
      })
      .select('id')
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  },

  /** Sends a saved campaign now. 409 (already taken by the cron, or not scheduled) → CAMPAIGN_NOT_CLAIMABLE. */
  async sendNow(campaignId: string): Promise<CampaignSendResult> {
    const { data, error } = await getSupabaseClient().functions.invoke('send-campaign', {
      body: { campaign_id: campaignId },
    });
    if (error) {
      const context = (error as { context?: unknown }).context;
      if (context instanceof Response && context.status === 409) {
        const body = (await context.json().catch(() => ({}))) as { status?: string | null };
        throw new AppError('La campaña ya se está enviando o ya no está programada.', 'CAMPAIGN_NOT_CLAIMABLE', 409, {
          status: body.status ?? null,
        });
      }
      throw error;
    }
    return data as CampaignSendResult;
  },

  /** 'cancelled', or the status that prevented it ('sending', 'sent', …), or 'not_found'. */
  async cancel(campaignId: string): Promise<string> {
    const { data, error } = await getSupabaseClient().rpc('cancel_campaign', { p_campaign_id: campaignId });
    if (error) {
      if ((error as { details?: string }).details === 'campaign_cancel_forbidden') {
        // 400, not 403: getErrorMessage turns 401/403 into "session expired".
        throw new AppError(error.message, 'CAMPAIGN_CANCEL_FORBIDDEN', 400);
      }
      throw error;
    }
    return data as string;
  },
};
