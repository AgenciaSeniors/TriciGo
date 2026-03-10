import { getSupabaseClient } from '../client';

export const notificationService = {
  async registerPushToken(
    userId: string,
    token: string,
    platform: string,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('user_devices')
      .upsert(
        { user_id: userId, push_token: token, platform },
        { onConflict: 'user_id,push_token' },
      );
    if (error) throw error;
  },

  async removePushToken(userId: string, token: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('user_devices')
      .delete()
      .eq('user_id', userId)
      .eq('push_token', token);
    if (error) throw error;
  },

  async getDeviceTokens(userId: string): Promise<string[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('user_devices')
      .select('push_token')
      .eq('user_id', userId)
      .not('push_token', 'is', null);
    if (error) throw error;
    return (data ?? []).map((row: { push_token: string }) => row.push_token);
  },

  async sendPushNotification(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ successCount: number; errorCount: number }> {
    if (tokens.length === 0) {
      return { successCount: 0, errorCount: 0 };
    }

    const messages = tokens.map((token) => ({
      to: token,
      title,
      body,
      sound: 'default' as const,
      ...(data ? { data } : {}),
    }));

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        console.error(
          `[notification] Expo push API returned status ${response.status}`,
        );
        return { successCount: 0, errorCount: tokens.length };
      }

      const result = (await response.json()) as {
        data: Array<{ status: 'ok' | 'error'; id?: string; message?: string }>;
      };

      let successCount = 0;
      let errorCount = 0;
      for (const ticket of result.data) {
        if (ticket.status === 'ok') {
          successCount++;
        } else {
          errorCount++;
          console.warn(
            `[notification] Push ticket error: ${ticket.message ?? 'unknown'}`,
          );
        }
      }

      return { successCount, errorCount };
    } catch (err) {
      console.error('[notification] Failed to send push notifications:', err);
      return { successCount: 0, errorCount: tokens.length };
    }
  },

  async notifyUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const tokens = await this.getDeviceTokens(userId);
    if (tokens.length === 0) {
      return;
    }

    const { successCount, errorCount } = await this.sendPushNotification(
      tokens,
      title,
      body,
      data,
    );
    console.log(
      `[notification] notifyUser ${userId}: ${successCount} sent, ${errorCount} failed`,
    );
  },
};
