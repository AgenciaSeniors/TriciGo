import { useEffect, useCallback, useRef } from 'react';
import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { chatService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { useChatStore } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';

// BUG-243: outgoing chat queue persisted to AsyncStorage. When user types
// offline (Cuban networks drop frequently), the message stays in queue
// with a visible 'pending' or 'failed' flag. On reconnect, we drain.
const QUEUE_KEY = '@tricigo/chat_outgoing_queue';
type QueuedMessage = {
  localId: string;
  rideId: string;
  senderId: string;
  body: string;
  attemptCount: number;
  queuedAt: number;
};
async function readQueue(): Promise<QueuedMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
async function writeQueue(items: QueuedMessage[]): Promise<void> {
  try { await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch { /* best effort */ }
}
async function enqueue(msg: QueuedMessage): Promise<void> {
  const q = await readQueue();
  q.push(msg);
  await writeQueue(q);
}
async function removeFromQueue(localId: string): Promise<void> {
  const q = await readQueue();
  await writeQueue(q.filter((m) => m.localId !== localId));
}

const TYPING_TIMEOUT_MS = 3000;
const TYPING_DEBOUNCE_MS = 2000;

export function useChatInit(rideId: string) {
  const setMessages = useChatStore((s) => s.setMessages);
  const addMessage = useChatStore((s) => s.addMessage);
  const setRemoteTyping = useChatStore((s) => s.setRemoteTyping);
  const reset = useChatStore((s) => s.reset);
  const userId = useAuthStore((s) => s.user?.id);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let msgChannel: ReturnType<typeof chatService.subscribeToMessages> | null = null;
    let typingChannel: ReturnType<typeof chatService.subscribeToTyping> | null = null;

    // Every message id this mount has already handled. The poll below used to
    // dedupe against the STORE, which caps at MAX_MESSAGES (200): past that
    // length the trimmed-off messages are no longer "existing", so every poll
    // re-fetched them and re-appended them AT THE END — the thread reordered
    // itself every 8 seconds, permanently. An unbounded Set remembers what was
    // seen regardless of what the store still holds. (The driver hook has
    // always done it this way; this brings the rider in line.)
    const seenIds = new Set<string>();

    chatService
      .getMessages(rideId)
      .then((msgs) => {
        msgs.forEach((m) => seenIds.add(m.id));
        setMessages(msgs);
      })
      .catch((err) => logger.warn('[Chat] Failed to load messages:', { error: String(err) }));

    msgChannel = chatService.subscribeToMessages(rideId, (msg) => {
      if (seenIds.has(msg.id)) return;
      seenIds.add(msg.id);
      addMessage(msg);
    });

    // Subscribe to typing events
    if (userId) {
      typingChannel = chatService.subscribeToTyping(rideId, userId, () => {
        setRemoteTyping(true);
        // Auto-clear after timeout
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
          setRemoteTyping(false);
        }, TYPING_TIMEOUT_MS);
      });
    }

    // BUG-242: polling fallback for chat messages. The realtime channel
    // is unstable in Cuban networks (CHANNEL_ERROR loop). Without this,
    // messages from the other party never appear until reload. Every 8s
    // we fetch fresh messages and merge any not in store.
    const pollInterval = setInterval(async () => {
      try {
        const fresh = await chatService.getMessages(rideId);
        const newMessages = fresh.filter((m) => !seenIds.has(m.id));
        if (newMessages.length > 0) {
          // eslint-disable-next-line no-console
          console.log('[Chat] poll: new messages found', { count: newMessages.length });
          newMessages.forEach((m) => { seenIds.add(m.id); addMessage(m); });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[Chat] poll failed', String(err));
      }
    }, 8_000);

    return () => {
      msgChannel?.unsubscribe();
      typingChannel?.unsubscribe();
      clearInterval(pollInterval);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      reset();
    };
  }, [rideId, userId]);
}

export function useChatActions(rideId: string) {
  const user = useAuthStore((s) => s.user);
  const addMessage = useChatStore((s) => s.addMessage);
  const lastTypingRef = useRef(0);

  const sendMessage = useCallback(
    async (body: string) => {
      if (!user || !body.trim()) return;
      const trimmed = body.trim();
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // BUG-243: Add optimistic message FIRST so user sees it immediately,
      // then try to send. If send fails, the message is already queued
      // for later retry with a visible "pending" indicator.
      addMessage({
        id: localId,
        ride_id: rideId,
        sender_id: user.id,
        body: trimmed,
        created_at: new Date().toISOString(),
        _pending: true,
      } as any);

      try {
        const msg = await chatService.sendMessage(rideId, user.id, trimmed);
        // Replace local pending with server message
        useChatStore.getState().messages
          .filter((m) => m.id === localId)
          .forEach(() => { /* will be replaced below */ });
        // Remove the local pending entry and add the real one
        const cur = useChatStore.getState().messages;
        useChatStore.getState().setMessages(cur.filter((m) => m.id !== localId));
        addMessage(msg);
      } catch {
        // Mark as queued in AsyncStorage and update bubble to "pending"
        await enqueue({
          localId,
          rideId,
          senderId: user.id,
          body: trimmed,
          attemptCount: 1,
          queuedAt: Date.now(),
        });
        // Update local store: still pending, will retry on reconnect
        const cur = useChatStore.getState().messages;
        useChatStore.getState().setMessages(
          cur.map((m) => m.id === localId ? { ...m, _failed: false, _pending: true } as any : m),
        );
        Toast.show({
          type: 'info',
          text1: i18next.t('rider:chat.queued', { defaultValue: 'Mensaje en cola' }),
          text2: i18next.t('rider:chat.queued_hint', { defaultValue: 'Se enviará cuando vuelva la conexión' }),
        });
      }
    },
    [rideId, user, addMessage],
  );

  // BUG-243: drain queue when network comes back
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(async (state) => {
      if (!state.isConnected) return;
      const q = await readQueue();
      if (q.length === 0) return;
      // eslint-disable-next-line no-console
      console.log('[Chat] draining queue', { count: q.length });
      for (const item of q) {
        try {
          const msg = await chatService.sendMessage(item.rideId, item.senderId, item.body);
          await removeFromQueue(item.localId);
          // The queue is GLOBAL but the store holds a single thread with no
          // ride id. Without this guard, a message queued on ride A while
          // offline lands in whatever chat happens to be open when the network
          // returns — the other party's conversation shows a bubble that was
          // never meant for it. The message itself goes to the right ride
          // (sendMessage uses item.rideId); it is the local echo that leaks.
          // The web hook has carried this guard for a while; the mobile ones
          // never got it.
          if (item.rideId !== rideId) continue;
          const cur = useChatStore.getState().messages;
          useChatStore.getState().setMessages(cur.filter((m) => m.id !== item.localId));
          addMessage(msg);
        } catch {
          // still failing; leave in queue, increment attempt count
          const all = await readQueue();
          await writeQueue(all.map((m) => m.localId === item.localId ? { ...m, attemptCount: m.attemptCount + 1 } : m));
        }
      }
    });
    return () => unsubscribe();
  }, [addMessage, rideId]);

  /** Call on every keystroke — internally debounces broadcasts */
  const notifyTyping = useCallback(() => {
    if (!user) return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_DEBOUNCE_MS) return;
    lastTypingRef.current = now;
    chatService.broadcastTyping(rideId, user.id);
  }, [rideId, user]);

  return { sendMessage, notifyTyping };
}
