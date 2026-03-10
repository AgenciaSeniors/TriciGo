import { create } from 'zustand';
import type { ChatMessage } from '@tricigo/types';

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  setMessages: (messages) => set({ messages, isLoading: false }),
  addMessage: (message) => {
    const existing = get().messages;
    if (existing.some((m) => m.id === message.id)) return;
    set({ messages: [...existing, message] });
  },
  reset: () => set({ messages: [], isLoading: false }),
}));
