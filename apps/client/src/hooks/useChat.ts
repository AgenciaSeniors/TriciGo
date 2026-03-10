import { useEffect, useCallback } from 'react';
import { chatService } from '@tricigo/api';
import { useChatStore } from '@/stores/chat.store';
import { useAuthStore } from '@/stores/auth.store';

export function useChatInit(rideId: string) {
  const setMessages = useChatStore((s) => s.setMessages);
  const addMessage = useChatStore((s) => s.addMessage);
  const reset = useChatStore((s) => s.reset);

  useEffect(() => {
    let channel: ReturnType<typeof chatService.subscribeToMessages> | null = null;

    chatService
      .getMessages(rideId)
      .then(setMessages)
      .catch(() => {});

    channel = chatService.subscribeToMessages(rideId, addMessage);

    return () => {
      channel?.unsubscribe();
      reset();
    };
  }, [rideId]);
}

export function useChatActions(rideId: string) {
  const user = useAuthStore((s) => s.user);
  const addMessage = useChatStore((s) => s.addMessage);

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

  return { sendMessage };
}
