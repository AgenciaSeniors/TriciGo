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
};
