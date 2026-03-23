import { useEffect, useCallback, useRef } from 'react';
import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import { chatService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
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

    chatService
      .getMessages(rideId)
      .then(setMessages)
      .catch((err) => logger.warn('[Chat] Failed to load messages:', err));

    msgChannel = chatService.subscribeToMessages(rideId, addMessage);

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

    return () => {
      msgChannel?.unsubscribe();
      typingChannel?.unsubscribe();
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
        // Show optimistic message with error indicator
        addMessage({
          id: `local-${Date.now()}`,
          ride_id: rideId,
          sender_id: user.id,
          body: body.trim(),
          created_at: new Date().toISOString(),
          _failed: true,
        } as any);
        Toast.show({ type: 'error', text1: i18next.t('rider:chat.send_failed', { defaultValue: 'Mensaje no enviado' }) });
      }
    },
    [rideId, user, addMessage],
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
