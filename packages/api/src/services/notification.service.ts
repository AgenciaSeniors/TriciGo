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
};
