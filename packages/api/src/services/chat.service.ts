// ============================================================
// TriciGo — Chat Service (in-ride messaging)
// ============================================================

import { getSupabaseClient } from '../client';
import type { ChatMessage } from '@tricigo/types';
import { realtimeStatusLogger } from './_realtime-status';
import { validate, sendMessageSchema } from '../schemas';

export const chatService = {
  /**
   * Messages of a ride, oldest first.
   *
   * `limit` caps it to the most recent N (still returned oldest-first, so the
   * caller renders them in order). The chat screen polls this every 8s and the
   * unread badge used to as well; pulling an unbounded thread on a timer is
   * fine at two messages and wasteful at two hundred.
   */
  async getMessages(rideId: string, limit?: number): Promise<ChatMessage[]> {
    const supabase = getSupabaseClient();

    if (limit != null) {
      // Newest-first + limit, then flip: taking the LAST N needs the sort
      // reversed, otherwise a limit would return the oldest N and the chat
      // would appear frozen in the past.
      const { data, error } = await supabase
        .from('ride_messages')
        .select('*')
        .eq('ride_id', rideId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as ChatMessage[]).reverse();
    }

    const { data, error } = await supabase
      .from('ride_messages')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ChatMessage[];
  },

  /**
   * How many messages in this ride were sent TO me and are still unread.
   *
   * A `count`/`head` query — no rows cross the wire. The badge used to fetch
   * the whole thread every 12s just to compute a number.
   */
  async getUnreadCount(rideId: string, myUserId: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from('ride_messages')
      .select('id', { count: 'exact', head: true })
      .eq('ride_id', rideId)
      .neq('sender_id', myUserId)
      .is('read_at', null);
    if (error) throw error;
    return count ?? 0;
  },

  /**
   * Mark every message this user RECEIVED in this ride as read (00516).
   *
   * Goes through the `mark_ride_messages_read` RPC because ride_messages has
   * no UPDATE policy on purpose — a sent message is immutable, and opening
   * UPDATE for a timestamp would also open `body`. The RPC performs one fixed
   * UPDATE and nothing else.
   *
   * Returns how many were marked. Tolerates the RPC being absent (a build that
   * ships ahead of the migration): the chat simply behaves as it did before,
   * with nothing ever showing as read.
   */
  async markRead(rideId: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('mark_ride_messages_read', {
      p_ride_id: rideId,
    });
    if (error) {
      // 42883 = undefined_function — migration 00516 not applied yet.
      if (error.code === '42883' || /function.*does not exist/i.test(error.message)) {
        return 0;
      }
      throw error;
    }
    return typeof data === 'number' ? data : 0;
  },

  async sendMessage(
    rideId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessage> {
    const valid = validate(sendMessageSchema, { rideId, senderId, body });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('ride_messages')
      .insert({ ride_id: valid.rideId, sender_id: valid.senderId, body: valid.body })
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
      .subscribe(realtimeStatusLogger('chat_messages'));
  },

  // ==================== TYPING INDICATOR ====================

  /**
   * Subscribe to typing events — and, optionally, to presence.
   *
   * Both ride on the SAME ephemeral channel on purpose. A third channel per
   * open chat screen is exactly the connection pressure BUG-277 was about
   * (OkHttp maxRequestsPerHost), and presence needs no more than a channel
   * that is already subscribed.
   *
   * `onPresence` reports whether the OTHER party currently has this chat
   * open — not whether they are online in the app. Anything the UI says
   * about it has to be worded that narrowly, or it is a guess dressed up as
   * a fact.
   *
   * The channel is PRIVATE (00626): realtime.messages lets only the ride's
   * customer and driver join it. On a public channel anyone holding the ride
   * id could see who has the chat open and fake typing. A private and a public
   * channel with the same name never reach each other, so an older build on
   * the public one and a newer build on this one do not see each other type.
   *
   * Returns the channel so the caller can unsubscribe.
   */
  subscribeToTyping(
    rideId: string,
    myUserId: string,
    onTyping: (userId: string) => void,
    onPresence?: (otherPartyPresent: boolean) => void,
  ) {
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`typing:${rideId}`, { config: { private: true, presence: { key: myUserId } } })
      .on('broadcast', { event: 'typing' }, (payload) => {
        const senderId = payload.payload?.user_id as string | undefined;
        if (senderId && senderId !== myUserId) {
          onTyping(senderId);
        }
      });

    if (onPresence) {
      const report = () => {
        const keys = Object.keys(channel.presenceState() ?? {});
        onPresence(keys.some((k) => k !== myUserId));
      };
      channel
        .on('presence', { event: 'sync' }, report)
        .on('presence', { event: 'join' }, report)
        .on('presence', { event: 'leave' }, report);
    }

    const log = realtimeStatusLogger('chat_typing');
    // Attach the user's JWT to the socket first: a private join without it is
    // refused. If the screen already left (unsubscribe drops the channel from
    // getChannels()), joining now would leave it open for nobody.
    supabase.realtime
      .setAuth()
      .then(() => {
        if (!supabase.getChannels().includes(channel)) return;
        channel.subscribe((status, err) => {
          log(status, err);
          // track() only works once the socket is joined; announcing earlier is
          // a silent no-op and the other side never sees us.
          if (onPresence && status === 'SUBSCRIBED') {
            void channel.track({ user_id: myUserId });
          }
        });
      })
      .catch(() => { /* best-effort: the typing indicator is supplementary */ });

    return channel;
  },

  /**
   * Broadcast a typing event for the current user.
   * Reuses the chat screen's channel, or creates a short-lived private one.
   */
  broadcastTyping(rideId: string, userId: string) {
    const supabase = getSupabaseClient();
    const channelName = `typing:${rideId}`;

    // Try to find an existing channel, otherwise create one. Until it joins,
    // send() goes over REST with the channel's private flag and the user's JWT.
    const channels = supabase.getChannels();
    let channel = channels.find((c) => c.topic === `realtime:${channelName}`);

    if (!channel) {
      const created = supabase.channel(channelName, { config: { private: true } });
      channel = created;
      supabase.realtime
        .setAuth()
        .then(() => {
          if (supabase.getChannels().includes(created)) created.subscribe();
        })
        .catch(() => { /* best-effort */ });
    }

    channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: userId },
    });
  },
};
