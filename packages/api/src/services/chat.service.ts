// ============================================================
// TriciGo — Chat Service (in-ride messaging)
// ============================================================

import { getSupabaseClient } from '../client';
import type { ChatMessage } from '@tricigo/types';

export const chatService = {
  async getMessages(rideId: string): Promise<ChatMessage[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_messages')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ChatMessage[];
  },

  async sendMessage(
    rideId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessage> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_messages')
      .insert({ ride_id: rideId, sender_id: senderId, body })
      .select()
      .single();
    if (error) throw error;
    return data as ChatMessage;
  },

  subscribeToMessages(
    rideId: string,
    onMessage: (msg: ChatMessage) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`chat:${rideId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ride_messages',
          filter: `ride_id=eq.${rideId}`,
        },
        (payload) => {
          onMessage(payload.new as ChatMessage);
        },
      )
      .subscribe();
  },

  // ==================== TYPING INDICATOR ====================

  /**
   * Subscribe to typing events for a ride chat.
   * Uses Supabase Realtime Broadcast (ephemeral, no DB writes).
   * Returns the channel so the caller can unsubscribe.
   */
  subscribeToTyping(
    rideId: string,
    myUserId: string,
    onTyping: (userId: string) => void,
  ) {
    const supabase = getSupabaseClient();
    return supabase
      .channel(`typing:${rideId}`)
      .on('broadcast', { event: 'typing' }, (payload) => {
        const senderId = payload.payload?.user_id as string | undefined;
        if (senderId && senderId !== myUserId) {
          onTyping(senderId);
        }
      })
      .subscribe();
  },

  /**
   * Broadcast a typing event for the current user.
   * Reuses or creates a short-lived channel.
   */
  broadcastTyping(rideId: string, userId: string) {
    const supabase = getSupabaseClient();
    const channelName = `typing:${rideId}`;

    // Try to find an existing channel, otherwise create one
    const channels = supabase.getChannels();
    let channel = channels.find((c) => c.topic === `realtime:${channelName}`);

    if (!channel) {
      channel = supabase.channel(channelName);
      channel.subscribe();
    }

    channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: userId },
    });
  },
};
