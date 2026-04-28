import { useEffect, useCallback, useRef } from 'react';
import { chatService } from '@tricigo/api';
import { useChatStore } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';

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

    const seenIds = new Set<string>();
    const pendingRealtime: Parameters<typeof addMessage>[0][] = [];
    let fetched = false;

    // Subscribe BEFORE fetching so no messages are lost in the gap
    msgChannel = chatService.subscribeToMessages(rideId, (msg) => {
      if (seenIds.has(msg.id)) return;
      seenIds.add(msg.id);
      if (fetched) {
        addMessage(msg);
      } else {
        // Buffer realtime messages that arrive before fetch completes
        pendingRealtime.push(msg);
      }
    });

    chatService
      .getMessages(rideId)
      .then((msgs) => {
        msgs.forEach((m) => seenIds.add(m.id));
        setMessages(msgs);
        fetched = true;
        // Flush any realtime messages that arrived during the fetch
        pendingRealtime.forEach((m) => addMessage(m));
        pendingRealtime.length = 0;
      })
      .catch((err) => console.warn('[Chat] Failed to load messages:', err));

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

    // BUG-242: polling fallback every 8s (was 30s) to handle Cuban
    // network instability where realtime channel silently disconnects.
    // 8s is the same interval used in client app for parity.
    const pollInterval = setInterval(() => {
      chatService.getMessages(rideId).then((msgs) => {
        const newMsgs = msgs.filter((m) => !seenIds.has(m.id));
        if (newMsgs.length > 0) {
          newMsgs.forEach((m) => { seenIds.add(m.id); addMessage(m); });
        }
      }).catch(() => { /* best-effort polling */ });
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
      try {
        const msg = await chatService.sendMessage(rideId, user.id, body.trim());
        addMessage(msg);
      } catch {
        // silent
      }
    },
    [rideId, user],
  );

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
