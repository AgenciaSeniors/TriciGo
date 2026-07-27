import { create } from 'zustand';
import type { ChatMessage } from '@tricigo/types';

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  remoteTyping: boolean;
  /** Does the OTHER party currently have this chat open? Fed by Realtime
   *  presence on the chat channel. Narrower than "is online" — that is all
   *  presence can honestly tell us, so it is all the UI may claim. */
  remotePresent: boolean;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  setRemoteTyping: (typing: boolean) => void;
  setRemotePresent: (present: boolean) => void;
  reset: () => void;
}

const MAX_MESSAGES = 200;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  remoteTyping: false,
  remotePresent: false,
  setMessages: (messages) =>
    set({ messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages, isLoading: false }),
  addMessage: (message) => {
    const existing = get().messages;
    if (existing.some((m) => m.id === message.id)) return;
    const updated = [...existing, message];
    set({
      messages: updated.length > MAX_MESSAGES ? updated.slice(-MAX_MESSAGES) : updated,
      remoteTyping: false, // Clear typing when a message arrives
    });
  },
  setRemoteTyping: (remoteTyping) => set({ remoteTyping }),
  setRemotePresent: (remotePresent) => set({ remotePresent }),
  reset: () => set({ messages: [], isLoading: false, remoteTyping: false, remotePresent: false }),
}));
